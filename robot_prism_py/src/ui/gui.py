"""Tkinter editor + sandbox front-end for the beam-puzzle engine.

Primitive graphics only (tkinter is bundled with CPython). The window doubles
as a level editor (place nodes / walls / fields, wire boolean logic) and a
real-time sandbox to play the puzzle, driving ``World.step`` once per frame.
"""

import math
import os
import time

from ..core.constants import (
    COLORS, DIM, PALETTE, PLAYER_R, BOX_R, BTN_R, CONNECT_REACH,
    DWELL_THRESH, SPEED, TICK, LOGIC_KINDS, DEBUG_KEYS,
)
from ..core.geometry import dist, pt_seg_dist
from ..core.entities import Node, Wall, Barrier, ForceField
from .keymap import key_action, decode_mods, MOVE_DIRS, _X11
from ..sim.level import build_level


def run_gui():
    # --- input-method bypass (the "WASD randomly goes dead" fix) -------------
    # On X11 a stuck input-method pre-edit (IBus / fcitx / XIM) silently eats key
    # events before they reach the window: movement dies, a full relaunch does NOT
    # restore it (the IME daemon outlives the game, so the state is global, not
    # per-process), changing layout does nothing, and the only thing that revives
    # it is tabbing to another app, typing, and pressing Enter -- which commits or
    # cancels that global pre-edit. A WASD game never wants its movement keys run
    # through a composer, so we detach this process from the IME and take raw key
    # events; the IME can then never swallow a keystroke. This must be set before
    # Tk wires up XIM (i.e. before tk.Tk()). Set ROBOT_PRISM_KEEP_IME=1 to opt out.
    if _X11 and not os.environ.get("ROBOT_PRISM_KEEP_IME"):
        os.environ["XMODIFIERS"] = "@im=none"

    import tkinter as tk

    w = build_level()
    state = {"mode": "play", "tool": "select", "color": "red",
             "pending": None, "link_src": None, "sel": None,
             "dwell": 0.0, "dirty": False, "msg": "", "live": False,
             "has_focus": True, "debug_keys": DEBUG_KEYS}
    held = set()
    mouse = {"x": 0, "y": 0}

    root = tk.Tk()
    root.title("Robot and her prism -- beam puzzle (edit + play)")
    bar = tk.Frame(root); bar.pack(fill="x")
    cv = tk.Canvas(root, width=1018, height=640, bg="#fafafa", highlightthickness=0); cv.pack()
    info = tk.Label(root, anchor="w", justify="left", font=("TkDefaultFont", 9)); info.pack(fill="x")

    def in_reach(nid):
        if w.carrying == nid:
            return True
        return bool(w.player) and dist(w.player, w.nodes[nid].pos) < CONNECT_REACH

    def step_now():
        # Play-mode solve: advance the world one real-time tick (cuts apply with the
        # CUT_LINGER delay, so dynamic / oscillating chains work). Mark the world
        # "live" so tick() keeps stepping until everything settles.
        w.step(time.monotonic())
        state["live"] = True

    def set_mode(m):
        state.update(mode=m, pending=None, link_src=None)
        if m == "play" and w.player_start:
            w.player = list(w.player_start)
        w.player_block = False
        state["dwell"] = 0.0
        w.solve(cold=True); refresh_bar(); redraw()

    def set_tool(t):
        state.update(tool=t, pending=None, link_src=None)
        refresh_bar()

    def refresh_bar():
        for c in bar.winfo_children():
            c.destroy()
        tk.Button(bar, text="EDIT", relief=("sunken" if state["mode"] == "edit" else "raised"),
                  command=lambda: set_mode("edit")).pack(side="left")
        tk.Button(bar, text="PLAY", relief=("sunken" if state["mode"] == "play" else "raised"),
                  command=lambda: set_mode("play")).pack(side="left")
        tk.Label(bar, text=" ").pack(side="left")
        if state["mode"] == "edit":
            for t in ["select", "source", "receiver", "connector", "button", "box",
                      "and", "or", "wall", "field", "tan", "purple",
                      "goal", "start", "link", "delete"]:
                tk.Button(bar, text=t, relief=("sunken" if state["tool"] == t else "raised"),
                          command=lambda t=t: set_tool(t)).pack(side="left")
            cm = tk.StringVar(value=state["color"])
            tk.OptionMenu(bar, cm, *PALETTE,
                          command=lambda v: state.__setitem__("color", v)).pack(side="left")
        else:
            tk.Label(bar, text="WASD move | E pick/drop | stand by a connector, click it, "
                              "then click a node to aim | C clear | R reset | G reset gates").pack(side="left")

    # ----- drawing -----
    def star_pts(cx, cy, r=16, ri=7, n=5):
        pts = []
        for i in range(2 * n):
            rad = r if i % 2 == 0 else ri
            ang = -math.pi / 2 + i * math.pi / n
            pts += [cx + rad * math.cos(ang), cy + rad * math.sin(ang)]
        return pts

    def diamond(cx, cy, r=13):
        return [cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy]

    def redraw():
        cv.delete("all")
        for b in w.barriers:
            cv.create_line(*b.p1, *b.p2, fill=COLORS[b.kind], width=6, capstyle="round")
        for wl in w.walls:
            cv.create_line(*wl.p1, *wl.p2, fill="#111", width=5, capstyle="round")
        for ff in w.ffs:
            if ff.is_open:
                cv.create_line(*ff.p1, *ff.p2, fill="#bfe3ec", width=3, dash=(3, 7))
            else:
                cv.create_line(*ff.p1, *ff.p2, fill="#8fd3e8", width=6)
        for (a, b) in w.links:
            cv.create_line(*w.nodes[a].pos, *w.nodes[b].pos, fill="#dddddd", width=1, dash=(2, 5))
        for (a, b, col, delivered) in w.beams_draw:
            shade = COLORS[col] if delivered else DIM.get(col, "#999")
            cv.create_line(*a, *b, fill=shade, width=4 if delivered else 3, capstyle="round")
            if not delivered:
                cv.create_oval(b[0] - 3, b[1] - 3, b[0] + 3, b[1] + 3, outline=shade, width=2)
        # logic wiring
        for (src, dst, neg) in w.logic_links:
            sp = w.nodes[src].pos if src in w.nodes else None
            dp = w.consumer_pos(dst)
            if not sp or not dp:
                continue
            active = (neg != bool(w.logic_val.get(src, False)))
            cv.create_line(*sp, *dp, fill=("#5aa0e0" if active else "#cbd3da"),
                           width=2, dash=(4, 3), arrow="last")
            if neg:
                mx, my = (sp[0] + dp[0]) / 2, (sp[1] + dp[1]) / 2
                cv.create_oval(mx - 5, my - 5, mx + 5, my + 5, fill="#fff",
                               outline="#c0392b", width=2)
                cv.create_text(mx, my, text="!", font=("TkDefaultFont", 7, "bold"), fill="#c0392b")
        # boxes
        for bx in w.boxes:
            x, y = bx
            on = any(dist(bx, n.pos) < BTN_R for n in w.nodes.values() if n.kind == "button")
            cv.create_rectangle(x - BOX_R, y - BOX_R, x + BOX_R, y + BOX_R,
                                fill=("#caa46a" if on else "#b08d57"), outline="#5b4523", width=2)
        # nodes
        for n in w.nodes.values():
            x, y = n.pos
            if n.kind == "source":
                cv.create_polygon(diamond(x, y), fill=COLORS.get(n.color, "#999"), outline="#222")
            elif n.kind == "receiver":
                lit = w.lit.get(n.id, False)
                cv.create_rectangle(x - 11, y - 13, x + 11, y + 13,
                                    outline=COLORS.get(n.color, "#999"), width=3,
                                    fill=COLORS[n.color] if lit else "#fff")
            elif n.kind == "button":
                pr = w.pressed.get(n.id, False)
                cv.create_oval(x - BTN_R, y - BTN_R, x + BTN_R, y + BTN_R,
                               fill=("#88d18b" if pr else "#e7e7e7"), outline="#555", width=2)
                cv.create_text(x, y, text="B", font=("TkDefaultFont", 8))
            elif n.kind in LOGIC_KINDS:
                on = w.logic_val.get(n.id, False)
                cv.create_rectangle(x - 17, y - 13, x + 17, y + 13,
                                    fill=("#bfe6c2" if on else "#eceff1"),
                                    outline="#516", width=2)
                cv.create_text(x, y, text=("AND" if n.kind == "and" else "OR"),
                               font=("TkDefaultFont", 8, "bold"))
            elif n.kind == "connector":
                near = state["mode"] == "play" and in_reach(n.id)
                ring = "#f5c518" if state["sel"] == n.id else ("#2e8b57" if near else "#222")
                col = w.emit.get(n.id)
                carried = w.carrying == n.id
                if w._conn_elevated(n.id):
                    cv.create_oval(x - 16, y - 16, x + 16, y + 16,
                                   outline="#8e44ad", width=2, dash=(2, 2))
                cv.create_oval(x - 12, y - 12, x + 12, y + 12,
                               fill=COLORS[col] if col else "#fff", outline=ring, width=3)
                cv.create_text(x, y, text=n.label or "C", font=("TkDefaultFont", 9, "bold"))
                if carried:
                    cv.create_text(x, y - 20, text="(carried)", font=("TkDefaultFont", 7), fill="#666")
                elif w._conn_elevated(n.id):
                    cv.create_text(x, y + 22, text="(raised)", font=("TkDefaultFont", 7), fill="#8e44ad")
        if w.goal:
            cv.create_polygon(star_pts(*w.goal), fill="#f5c518", outline="#b8860b")
        if w.player:
            px, py = w.player
            cv.create_oval(px - PLAYER_R, py - PLAYER_R, px + PLAYER_R, py + PLAYER_R,
                           fill=("#c0392b" if w.player_block else "#222"), outline="#fff", width=2)
            if state["mode"] == "play":
                cv.create_oval(px - CONNECT_REACH, py - CONNECT_REACH,
                               px + CONNECT_REACH, py + CONNECT_REACH,
                               outline="#e7e7e7", dash=(2, 4))
        if state["pending"]:
            p = state["pending"]
            cv.create_line(p[0], p[1], mouse["x"], mouse["y"], fill="#888", dash=(2, 2))
        gates = "  ".join(f"{ff.id}:{'open' if ff.is_open else 'shut'}" for ff in w.ffs)
        goal = "   *** GOAL REACHED ***" if w.at_goal() else ""
        tl = state["tool"] if state["mode"] == "edit" else "-"
        info.config(text=f"[{state['mode']}/{tl}]  gates: {gates}{goal}\n{state['msg']}")

    # ----- hit testing -----
    def node_at(x, y, kinds=None):
        best, bd = None, 18
        for n in w.nodes.values():
            if kinds and n.kind not in kinds:
                continue
            d = dist((x, y), n.pos)
            if d < bd:
                best, bd = n, d
        return best

    def box_at(x, y):
        for i, bx in enumerate(w.boxes):
            if dist((x, y), bx) < BOX_R + 4:
                return i
        return None

    def field_at(x, y):
        for ff in w.ffs:
            if pt_seg_dist((x, y), ff.p1, ff.p2) < 8:
                return ff
        return None

    # ----- editing -----
    def edit_click(x, y):
        t = state["tool"]
        if t == "select":
            n = node_at(x, y)
            state["sel"] = n.id if (n and n.kind == "connector") else None
        elif t in ("source", "receiver"):
            w.add(Node(w.new_id(t[:3] + "_"), t, (x, y), color=state["color"]))
        elif t == "connector":
            w.add(Node(w.new_id("con_"), "connector", (x, y), label="+"))
        elif t == "button":
            w.add(Node(w.new_id("btn_"), "button", (x, y)))
        elif t in LOGIC_KINDS:
            w.add(Node(w.new_id(t + "_"), t, (x, y)))
        elif t == "box":
            w.boxes.append([x, y])
        elif t == "goal":
            w.goal = [x, y]
        elif t == "start":
            w.player_start = [x, y]; w.player = [x, y]
        elif t in ("wall", "field", "tan", "purple"):
            if state["pending"] is None:
                state["pending"] = (x, y); return
            p1, p2 = state["pending"], (x, y); state["pending"] = None
            if t == "wall":
                w.walls.append(Wall(p1, p2))
            elif t == "field":
                w.ffs.append(ForceField(w.new_id("ff_"), p1, p2))
            else:
                w.barriers.append(Barrier(p1, p2, t))
        elif t == "link":
            if state["link_src"] is None:
                n = node_at(x, y, kinds=("receiver", "button") + LOGIC_KINDS)
                if n:
                    state["link_src"] = n.id
                    state["msg"] = f"link from {n.id}: now click an AND/OR node or a field"
                return
            n = node_at(x, y, kinds=LOGIC_KINDS)
            dst = n.id if (n and n.id != state["link_src"]) else None
            if dst is None:
                ff = field_at(x, y)
                dst = ff.id if ff else None
            if dst:
                state["msg"] = w.toggle_logic_link(state["link_src"], dst)
                state["link_src"] = None
            else:
                state["msg"] = "click an AND/OR node or a field as the target"
        elif t == "delete":
            n = node_at(x, y)
            if n:
                w.remove_node(n.id); return
            bi = box_at(x, y)
            if bi is not None:
                w.boxes.pop(bi); return
            ff = field_at(x, y)
            if ff:
                w.remove_field(ff); return
            for (src, dst, neg) in list(w.logic_links):
                sp = w.nodes[src].pos if src in w.nodes else None
                dp = w.consumer_pos(dst)
                if sp and dp and pt_seg_dist((x, y), sp, dp) < 7:
                    w.logic_links.remove([src, dst, neg]); return
            for lst in (w.walls, w.barriers):
                for o in list(lst):
                    if pt_seg_dist((x, y), o.p1, o.p2) < 8:
                        lst.remove(o); return

    # ----- play interactions (proximity-gated) -----
    def play_click(x, y):
        if state["sel"] and not in_reach(state["sel"]):
            state["sel"] = None
        n = node_at(x, y)
        if n is None:
            state["sel"] = None
            return
        if n.kind == "connector":
            if state["sel"] and state["sel"] != n.id:
                w.toggle_link(state["sel"], n.id)          # aim selected at this connector
            elif state["sel"] == n.id:
                state["sel"] = None
            elif in_reach(n.id):
                state["sel"] = n.id
            else:
                state["msg"] = "move closer to that connector to adjust it"
        elif state["sel"]:
            w.toggle_link(state["sel"], n.id)              # aim selected connector at node

    # ----- events -----
    drag = {"id": None, "moved": False, "link_hit": None}

    def drag_player_to(tx, ty):
        # walk the player toward the cursor in small valid steps; move_player
        # honours walls, fields, barriers and pushes boxes just like WASD does.
        moved = False
        for _ in range(60):
            px, py = w.player
            dx, dy = tx - px, ty - py
            d = math.hypot(dx, dy)
            if d < 0.5:
                break
            step = min(6.0, d)
            before = tuple(w.player)
            w.move_player(dx / d * step, 0); w.move_player(0, dy / d * step)
            if tuple(w.player) == before:
                break          # fully blocked, stop nudging
            moved = True
        return moved

    def on_press(e):
        mouse.update(x=e.x, y=e.y)
        drag["moved"] = False
        drag["link_hit"] = None
        if state["mode"] == "edit" and state["tool"] == "select":
            n = node_at(e.x, e.y); bi = box_at(e.x, e.y)
            drag["id"] = ("node", n.id) if n else (("box", bi) if bi is not None else None)
        elif state["mode"] == "play" and w.player and dist((e.x, e.y), w.player) < PLAYER_R + 6:
            drag["id"] = ("player", None)
        else:
            drag["id"] = None

    def on_motion(e):
        mouse.update(x=e.x, y=e.y)
        if drag["id"] and state["mode"] == "edit" and state["tool"] == "select":
            drag["moved"] = True
            kind, ref = drag["id"]
            (w.nodes[ref].pos.__setitem__(slice(0, 2), [e.x, e.y]) if kind == "node"
             else w.boxes.__setitem__(ref, [e.x, e.y]))
            w.solve(cold=True)
        elif drag["id"] and drag["id"][0] == "player" and state["mode"] == "play":
            if drag_player_to(e.x, e.y):
                drag["moved"] = True
                if w.carrying:
                    cid = w.carrying
                    w.nodes[cid].pos[:] = [w.player[0], w.player[1]]
                    # dragging the carried connector over a connectable node
                    # toggles its link (debounced so each pass fires once).
                    tgt, best = None, 18
                    for nd in w.nodes.values():
                        if nd.id == cid or nd.kind not in ("source", "receiver", "connector"):
                            continue
                        dd = dist(w.player, nd.pos)
                        if dd < best:
                            tgt, best = nd, dd
                    if tgt is None:
                        drag["link_hit"] = None
                    elif tgt.id != drag["link_hit"]:
                        w.toggle_link(cid, tgt.id)
                        drag["link_hit"] = tgt.id
                        linked = tuple(sorted((cid, tgt.id))) in w.links
                        state["msg"] = f"{'linked' if linked else 'unlinked'} {cid} <-> {tgt.id}"
                w.solve(cold=True) if state["mode"] == "edit" else step_now()
        redraw()

    def on_release(e):
        if drag["moved"]:
            drag["id"] = None
            w.solve(cold=True) if state["mode"] == "edit" else step_now()
            redraw(); return
        drag["id"] = None
        (edit_click if state["mode"] == "edit" else play_click)(e.x, e.y)
        w.solve(cold=True) if state["mode"] == "edit" else step_now()
        redraw()

    def on_key(e):
        if state["debug_keys"]:
            print(f"[key] press   sym={e.keysym!r:>12}  code={e.keycode:<4} "
                  f"mods={decode_mods(e.state):<12} ({e.state:#06x})")
        if e.keysym == "F12":               # live-toggle the key trace, even mid-bug
            state["debug_keys"] = not state["debug_keys"]
            print(f"[key] debug trace {'ON' if state['debug_keys'] else 'OFF'}")
            return
        a = key_action(e)
        if a in MOVE_DIRS:
            held.add(a)
            return
        if state["mode"] == "play":
            if a == "carry":
                if w.carrying:
                    cid = w.carrying
                    # set-down: snap onto an adjacent box so the connector rests
                    # on it (elevated). Otherwise it stays where the player is.
                    best, bd = None, BOX_R + PLAYER_R + 8
                    for bx in w.boxes:
                        d = dist(w.player, bx)
                        if d < bd:
                            best, bd = bx, d
                    if best is not None:
                        w.nodes[cid].pos[:] = [best[0], best[1]]
                    w.carrying = None
                else:
                    best, bd = None, 30
                    for n in w.connectors():
                        d = dist(w.player, n.pos)
                        if d < bd and not w.reach_blocked(w.player, n.pos):
                            best, bd = n, d
                    if best:
                        w.carrying = best.id
                step_now(); redraw()
            elif a == "clear":
                if state["sel"] and in_reach(state["sel"]):
                    w.clear_links_of(state["sel"]); step_now(); redraw()
                elif state["sel"]:
                    state["msg"] = "move closer to clear that connector"
            elif a == "reset":
                w.player = list(w.player_start); w.carrying = None
                w.solve(cold=True); state["live"] = False; redraw()
            elif a == "gates":
                w.solve(cold=True); state["live"] = False
                state["msg"] = "gates reset (latches cleared)"; redraw()
        if a == "dump":
            print_state()

    def on_key_release(e):
        if state["debug_keys"]:
            print(f"[key] release sym={e.keysym!r:>12}  code={e.keycode:<4} "
                  f"mods={decode_mods(e.state):<12} ({e.state:#06x})")
        a = key_action(e)
        if a in MOVE_DIRS:
            held.discard(a)

    def on_focus_out(e):
        # Lost focus to another app (e.g. alt-tabbing to Discord): drop every held
        # key. Otherwise a movement key whose RELEASE lands in the other window
        # stays in `held` and the robot keeps running by itself. Guarded with
        # focus_displayof so focus moves between our own widgets don't count.
        if root.focus_displayof() is None:
            held.clear()
            state["has_focus"] = False

    def on_focus_in(e):
        state["has_focus"] = True

    def print_state():
        print("--- state ---")
        for n in w.connectors():
            print(f"  connector {n.id:10} emits {w.emit.get(n.id)}")
        for ff in w.ffs:
            ins = [(s, d, ng) for (s, d, ng) in w.logic_links if d == ff.id]
            print(f"  gate {ff.id:10} {'OPEN' if ff.is_open else 'shut'} inputs={ins}")

    def tick():
        # Self-heal a wedged focus flag. A <FocusIn> can occasionally go missing
        # across a window-manager transition, leaving has_focus stuck False so WASD
        # stays dead until relaunch. If we think we're unfocused but the OS says one
        # of our widgets actually holds focus, recover. This only ever flips toward
        # "focused", so a transient None can never wrongly freeze movement.
        if not state["has_focus"] and root.focus_displayof() is not None:
            state["has_focus"] = True
        if state["mode"] == "play" and w.player:
            now = time.monotonic()
            vx = ("right" in held) - ("left" in held)
            vy = ("down" in held) - ("up" in held)
            moved = False
            if (vx or vy) and state["has_focus"]:
                step = SPEED * TICK
                before = tuple(w.player)
                w.move_player(vx * step, 0); w.move_player(0, vy * step)
                moved = tuple(w.player) != before
            if w.carrying:
                w.nodes[w.carrying].pos[:] = [w.player[0], w.player[1]]
                state["dirty"] = True
            if state["sel"] and not in_reach(state["sel"]):
                state["sel"] = None
            # Update dwell / player-as-blocker first, since it feeds the solver.
            state["dwell"] = state["dwell"] + TICK if w.player_touching_beam() else 0.0
            want = state["dwell"] >= DWELL_THRESH
            block_changed = want != w.player_block
            if block_changed:
                w.player_block = want
            # Step the world while anything is in motion: the player moved, geometry
            # changed, a cut is mid-linger, or the previous step was still settling
            # (an oscillator keeps beams_live() true forever, so its clock runs). A
            # fully static scene steps nothing and burns no CPU.
            if (moved or state["dirty"] or block_changed
                    or w.beams_live() or state["live"]):
                state["live"] = w.step(now)
                state["dirty"] = False
            redraw()
        root.after(int(TICK * 1000), tick)

    cv.bind("<ButtonPress-1>", on_press)
    cv.bind("<B1-Motion>", on_motion)
    cv.bind("<ButtonRelease-1>", on_release)
    cv.bind("<Motion>", lambda e: (mouse.update(x=e.x, y=e.y),
                                    redraw() if state["pending"] else None))
    root.bind("<KeyPress>", on_key)
    root.bind("<KeyRelease>", on_key_release)
    root.bind("<FocusIn>", on_focus_in)
    root.bind("<FocusOut>", on_focus_out)

    refresh_bar(); w.solve(cold=True); redraw(); tick()
    root.mainloop()
