"""Player / box movement, reach and "theft" rules.

This is the *rules of motion* layer: what the player is allowed to do, kept
separate from the *physics of light* (the solver). It reads the scene from a
``World`` and, when a move could flip a gate, asks the ``Engine`` for a dry-run
settle to decide whether the move depends on a lock it would itself flip.
"""

from ..core.constants import EPS, PLAYER_R, BOX_R, BTN_R, BEAM_TOUCH
from ..core.geometry import seg_inter, first_block_t, dist, pt_seg_dist


class Motion:
    def __init__(self, world, engine):
        self.world = world        # scene state (entities, player, boxes, ...)
        self.engine = engine      # solver, for the latching dry-runs

    # ---- static collision ----
    def _static_blocked(self, old, new, carry):
        w = self.world
        segs = [(wl.p1, wl.p2) for wl in w.walls]
        for ff in w.ffs:
            if not ff.is_open:
                segs.append((ff.p1, ff.p2))
        for bar in w.barriers:
            if bar.kind == "tan" or (bar.kind == "purple" and carry):
                segs.append((bar.p1, bar.p2))
        for (s1, s2) in segs:
            r = seg_inter(old, new, s1, s2)
            if r:
                _, t, u = r
                if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
                    return True
        return False

    def _box_blocked(self, idx, old, new):
        w = self.world
        segs = [(wl.p1, wl.p2) for wl in w.walls]
        for ff in w.ffs:
            if not ff.is_open:
                segs.append((ff.p1, ff.p2))
        for bar in w.barriers:
            segs.append((bar.p1, bar.p2))
        for (s1, s2) in segs:
            r = seg_inter(old, new, s1, s2)
            if r:
                _, t, u = r
                if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
                    return True
        for j, bx in enumerate(w.boxes):
            if j != idx and dist(new, bx) < 2 * BOX_R - 2:
                return True
        return False

    def _press_set(self, player_pos, boxes):
        # which buttons would be held down for this player/box configuration.
        w = self.world
        out = {}
        for n in w.nodes.values():
            if n.kind != "button":
                continue
            bp = n.pos
            out[n.id] = bool(
                (player_pos and dist(player_pos, bp) < BTN_R)
                or any(dist(b, bp) < BTN_R for b in boxes)
                or any(c.kind == "connector" and c.id != w.carrying
                       and dist(c.pos, bp) < BTN_R for c in w.nodes.values()))
        return out

    def _hypothetical_open(self, player_pos, boxes):
        # Dry-run: which force-fields end up OPEN if the player and boxes were
        # in this configuration, settling with the SAME latching the live solver
        # uses (seeded from current gate states). All touched state is restored.
        w, eng = self.world, self.engine
        if not w.ffs:
            return {}
        saved = (w.player, w.boxes, w.pressed,
                 [ff.is_open for ff in w.ffs])
        w.player = list(player_pos) if player_pos else None
        w.boxes = [list(b) for b in boxes]
        try:
            for _ in range(30):
                w.pressed = {n.id: eng.button_pressed(n.id)
                             for n in w.nodes.values() if n.kind == "button"}
                emit, (beams, length, delivery) = eng.propagate()
                lit = eng._lit_map(beams, delivery)
                val = eng.evaluate_logic(lit, w.pressed)
                changed = False
                for ff in w.ffs:
                    nw = eng.field_open(ff, val)
                    if nw != ff.is_open:
                        ff.is_open = nw
                        changed = True
                if not changed:
                    break
            return {ff.id: ff.is_open for ff in w.ffs}
        finally:
            w.player, w.boxes, w.pressed = saved[0], saved[1], saved[2]
            for ff, s in zip(w.ffs, saved[3]):
                ff.is_open = s

    def _box_critical_fields(self, box_index, boxes):
        # Force-fields that are OPEN right now but would CLOSE if this particular
        # box stopped holding its button(s) -- i.e. gates this box itself props
        # open. The player may not reach across, step across, or shove the box
        # through such a gate, because doing so depends on the very lock the move
        # is about to flip. This is independent of the per-step push distance, so
        # it also stops the box from being walked off the button one nudge at a
        # time.
        w = self.world
        if not w.ffs or box_index is None:
            return []
        open_now = {ff.id for ff in w.ffs if ff.is_open}
        if not open_now:
            return []
        far = [list(b) for b in boxes]
        far[box_index] = [1e7, 1e7]            # lift this box out of the world
        after = self._hypothetical_open(w.player, far)
        return [(ff.p1, ff.p2) for ff in w.ffs
                if ff.id in open_now and not after.get(ff.id, True)]

    def _theft_blocked(self, old, new, reach_to, boxes_after,
                       push_idx=None, box_new=None):
        # Delimiting surfaces (walls, tan, purple, force-fields) must not be used
        # to reach across and "steal" a box, nor may a single move slip the player
        # across a field that the very same move causes to shut. A currently-open
        # immediate path is fine; a path that depends on a lock the move itself
        # flips is not.
        w = self.world

        def crosses(a, b, segs):
            for (s1, s2) in segs:
                r = seg_inter(a, b, s1, s2)
                if r:
                    _, t, u = r
                    if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
                        return True
            return False

        closed_now = [(ff.p1, ff.p2) for ff in w.ffs if not ff.is_open]
        # Only pay for a latching dry-run when the move can actually move a gate:
        # a shoved box (light may shift), the player's body blocking light, or a
        # change in which buttons are held.
        need_dry = bool(w.ffs) and (
            reach_to is not None
            or w.player_block
            or self._press_set(old, w.boxes) != self._press_set(new, boxes_after))
        if need_dry:
            after_open = self._hypothetical_open(new, boxes_after)
            closed_after = [(ff.p1, ff.p2) for ff in w.ffs
                            if not after_open.get(ff.id, True)]
        else:
            closed_after = closed_now

        # The player's own step may not ride a closing gate across.
        if crosses(old, new, closed_after):
            return True
        # Reaching out to shove a box may not cross any delimiting surface, nor a
        # field that is shut now or becomes shut once the box has been moved.
        barrier_segs = [(b.p1, b.p2) for b in w.barriers]   # tan + purple
        wall_segs = [(wl.p1, wl.p2) for wl in w.walls]
        if reach_to is not None and crosses(
                old, reach_to, wall_segs + barrier_segs + closed_now + closed_after):
            return True

        # A box may not be reached across, walked across, or pushed through a gate
        # that the box itself is currently holding open: taking it that way relies
        # on a lock the move flips. Robust against nudging the box off one step at
        # a time, since "held open by this box" doesn't depend on the step size.
        if push_idx is not None:
            crit = self._box_critical_fields(push_idx, w.boxes)
            if crit and (crosses(old, reach_to, crit)        # reach across the gate
                         or crosses(old, new, crit)          # player body across it
                         or (box_new is not None
                             and crosses(reach_to, box_new, crit))):  # box through it
                return True
        return False

    def move_player(self, dx, dy):
        w = self.world
        if not w.player:
            return
        old = tuple(w.player)
        new = (old[0] + dx, old[1] + dy)
        carry = w.carrying is not None
        hit = None
        for i, bx in enumerate(w.boxes):
            if dist(new, bx) < PLAYER_R + BOX_R - 2:
                hit = i
                break
        if hit is not None:
            bx = tuple(w.boxes[hit])
            nb = (bx[0] + dx, bx[1] + dy)
            if self._box_blocked(hit, bx, nb) or self._static_blocked(old, new, carry):
                return
            boxes_after = [list(b) for b in w.boxes]
            boxes_after[hit] = [nb[0], nb[1]]
            if self._theft_blocked(old, new, bx, boxes_after,
                                   push_idx=hit, box_new=nb):
                return
            w.boxes[hit] = [nb[0], nb[1]]
            w.player = [new[0], new[1]]
            return
        if self._static_blocked(old, new, carry):
            return
        if self._theft_blocked(old, new, None, w.boxes):
            return
        w.player = [new[0], new[1]]

    def reach_blocked(self, a, b):
        # Line-of-sight for the player's hands: you cannot grab (and thus pull /
        # "teleport") an object through a delimiting surface. Walls and ALL
        # force-fields -- open or closed -- block, and so do tan and purple
        # barriers: a barrier you cannot carry an object *through* is equally a
        # barrier you cannot reach across to snatch one from the far side.
        w = self.world
        segs = [(wl.p1, wl.p2) for wl in w.walls]
        segs += [(ff.p1, ff.p2) for ff in w.ffs]
        segs += [(bar.p1, bar.p2) for bar in w.barriers]
        return first_block_t(a, b, segs) is not None

    def at_goal(self):
        w = self.world
        return w.player and w.goal and dist(w.player, w.goal) < 18

    def player_touching_beam(self):
        w = self.world
        return any(pt_seg_dist(w.player, a, b) < BEAM_TOUCH
                   for (a, b, _, _) in w.beams_draw)
