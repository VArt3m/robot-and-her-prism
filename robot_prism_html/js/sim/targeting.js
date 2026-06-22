/**
 * The targeting FRAMEWORK.
 *
 * Every object whose type sets `requiresTarget` shares ONE interaction core,
 * which lives in the UI and is identical for all of them:
 *
 *   • a long-press on E, or a long left-mouse press, begins targeting;
 *   • a golden arrow is available in the window 0.333 s … 0.833 s into the press;
 *   • staying in the ring through that window drops into click-by-click;
 *   • a click on an intent ray deletes it;
 *   • C clears every intent of the carried device.
 *
 * None of that is re-described per object. What actually differs from one
 * targetable object to the next is captured ENTIRELY by a spec in this file:
 *
 *   maxIntents   how many intents the device may hold (Infinity, 1, …). Declared
 *               for clarity; `apply` is what actually enforces it.
 *   persistent   does marking record undoable world state (and re-run the sim)?
 *               A `false` device is "mark-only": it has no stored intent yet.
 *   sweep        how the golden arrow marks on pass-over: 'toggle' (link-style —
 *               re-entering a target flips it) or 'set' (last target wins). Omit
 *               for a device that does not mark on a sweep.
 *   dragAutoWire may dragging the character past targets mark them too? (A
 *               connector convenience; off for everything else.)
 *   flash        optional key into STR.flash, shown after a successful mark.
 *   targetAt(world, deviceId, x, y) -> { id, pos } | null
 *               the targetable thing under the cursor; `pos` is where its ray ends.
 *   apply(world, deviceId, targetId)
 *               record the intent, honouring maxIntents.
 *   intentRays(world) -> [{ from, to, key, owners, remove() }]
 *               every stored intent ray of THIS kind, globally, for click-delete.
 *               `key` dedupes a ray shared by two devices; `owners` lists the
 *               node id(s) the ray belongs to (both endpoints for a light link),
 *               so a click-delete can exclude the carried device's own intents;
 *               `remove()` deletes that one intent. Empty for a mark-only device.
 *   candidates(world, deviceId, origin) -> [{ id, pos, reachable }]
 *               every thing this device could currently target, with `reachable`
 *               telling whether a ray from `origin` (default: the device's own
 *               position) reaches it unobstructed. Drives the UI's "possible
 *               targets" highlight and the panel's covered-target detection. A
 *               device whose effect ignores line of sight (the connector's links)
 *               reports `reachable: true` for every candidate.
 *   clear(world, deviceId)
 *               drop every intent the device holds (the C key).
 *
 * To add a new targetable object: set `requiresTarget: true` on its type and add
 * one entry here. The interaction core does not change.
 */

import { dist, pt_seg_dist } from '../core/geometry.js';
import { kindIsJammable } from './objects.js';
import { RELAY_SPECS, isCorruptibleKind } from './relays.js';

// The node kinds a light wire may attach to: sources, receivers, and every relay
// (connector / inverter / mixer / future sister). Built from the relay registry so
// a new sister needs no edit here.
const WIRE_KINDS = ['source', 'receiver', ...Object.keys(RELAY_SPECS)];

// The node kinds a rewirer may RECOLOUR: sources, receivers, and only the
// CORRUPTIBLE relays. A non-corruptible relay (the mixer) is excluded — it cannot
// be locked to a colour, so it is never offered as a recolour target either.
const RECOLOR_KINDS = ['source', 'receiver', ...Object.keys(RELAY_SPECS).filter(isCorruptibleKind)];

const HIT = 18;   // how near a click / arrow tip must fall, in world units

function nearestNode(world, x, y, kinds, excludeId) {
  let best = null, bd = HIT;
  for (const n of Object.values(world.nodes)) {
    if (n.id === excludeId || !kinds.includes(n.kind)) continue;
    const d = dist([x, y], n.pos);
    if (d < bd) { best = n; bd = d; }
  }
  return best;
}

// Every node of one of `kinds` that could be targeted (excluding the device
// itself and any spent/destroyed node). Shared by the connector and rewirer
// candidate enumerators.
function nodesOfKinds(world, kinds, excludeId) {
  return Object.values(world.nodes)
    .filter(n => n.id !== excludeId && !n.spent && kinds.includes(n.kind));
}

// The targeting spec shared by every relay that wires light (connector,
// inverter, …). A factory so each kind gets its own object (no shared identity).
function WIRE_SPEC() {
  return {
    maxIntents: Infinity,
    persistent: true,
    sweep: 'toggle',
    dragAutoWire: true,
    flash: null,
    targetAt(world, deviceId, x, y) {
      const n = nearestNode(world, x, y, WIRE_KINDS, deviceId);
      return n ? { id: n.id, pos: n.pos } : null;
    },
    apply(world, deviceId, targetId) { world.toggle_link(deviceId, targetId); },
    // A light link can be wired regardless of obstruction (the beam simply will
    // not deliver through a wall) — so every wireable node is a reachable candidate.
    candidates(world, deviceId) {
      return nodesOfKinds(world, WIRE_KINDS, deviceId)
        .map(n => ({ id: n.id, pos: [...n.pos], reachable: true }));
    },
    intentRays(world) {
      return world.links_pairs.map(([a, b]) => ({
        from: world.nodes[a].pos,
        to: world.nodes[b].pos,
        owners: [a, b],
        key: (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`),
        remove: () => world.toggle_link(a, b),
      }));
    },
    clear(world, deviceId) { world.clear_links_of(deviceId); },
  };
}

export const TARGET_SPECS = {
  // Connector & inverter — both wire light between any number of sources,
  // receivers and relays. Identical targeting behaviour, so they share one spec.
  // Many intents; the golden arrow toggles links on pass-over and a
  // character-drag does the same as a convenience.
  connector: WIRE_SPEC(),
  inverter:  WIRE_SPEC(),
  mixer:     WIRE_SPEC(),

  // Accumulator — a portable source that wires light like a connector, but what
  // it may target depends on its state. A CHARGED accumulator is a source, so it
  // may feed receivers, relays and (to clash) sources. An EMPTY one is only being
  // filled, so it wires to sources and relays (a receiver cannot fill it). Many
  // intents, toggled on pass-over; no character-drag convenience.
  accumulator: (() => {
    const kindsFor = (world, deviceId) => {
      const relays = Object.keys(RELAY_SPECS);
      return world.nodes[deviceId]?.color
        ? ['source', 'receiver', ...relays]      // charged: a source, may feed receivers
        : ['source', ...relays];                 // empty: wires to sources/relays to be filled
    };
    return {
      maxIntents: Infinity,
      persistent: true,
      sweep: 'toggle',
      dragAutoWire: false,
      flash: null,
      targetAt(world, deviceId, x, y) {
        const n = nearestNode(world, x, y, kindsFor(world, deviceId), deviceId);
        return n ? { id: n.id, pos: n.pos } : null;
      },
      apply(world, deviceId, targetId) { world.toggle_link(deviceId, targetId); },
      candidates(world, deviceId) {
        return nodesOfKinds(world, kindsFor(world, deviceId), deviceId)
          .map(n => ({ id: n.id, pos: [...n.pos], reachable: true }));
      },
      // Light links share one set; surfacing every link here (deduped by key with
      // the relay specs) keeps click-delete working for accumulator links too.
      intentRays(world) {
        return world.links_pairs.map(([a, b]) => ({
          from: world.nodes[a].pos,
          to: world.nodes[b].pos,
          owners: [a, b],
          key: (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`),
          remove: () => world.toggle_link(a, b),
        }));
      },
      clear(world, deviceId) { world.clear_links_of(deviceId); },
    };
  })(),

  // Rewirer — holds one intent (re-marking overwrites). With a clear shot (the
  // rewirer ray profile) it recolours a source, receiver, or connector after a
  // short charge, then is spent. The golden arrow sets the single target.
  rewirer: {
    maxIntents: 1,
    persistent: true,
    sweep: 'set',
    flash: 'recolourMarked',
    targetAt(world, deviceId, x, y) {
      const n = nearestNode(world, x, y, RECOLOR_KINDS, deviceId);
      return n ? { id: n.id, pos: n.pos } : null;
    },
    apply(world, deviceId, targetId) { world.set_recolor(deviceId, targetId); },
    // Recolour needs a clear shot (the rewirer ray profile), checked from
    // `origin` (the robot while carrying). The device body and the target are
    // excluded so neither self-blocks.
    candidates(world, deviceId, origin = world.nodes[deviceId]?.pos) {
      return nodesOfKinds(world, RECOLOR_KINDS, deviceId)
        .map(n => ({
          id: n.id, pos: [...n.pos],
          reachable: origin ? world.ray_clear(origin, n.pos, 'rewirer',
            { excludeNodeIds: new Set([deviceId, n.id]) }) : true,
        }));
    },
    intentRays(world) {
      const out = [];
      for (const [rid, tid] of world.recolor_links) {
        const rw = world.nodes[rid], tg = world.nodes[tid];
        if (!rw || !tg || rw.spent) continue;
        out.push({
          from: rw.pos, to: tg.pos,
          owners: [rid],
          key: `recolor\u0000${rid}`,         // one intent per rewirer
          remove: () => world.clear_recolor(rid),
        });
      }
      return out;
    },
    clear(world, deviceId) { world.clear_recolor(deviceId); },
  },

  // Jammer — holds exactly one intent. With line of sight (re-checked live once
  // deployed) it forces a force field, or a jammable node, into the disabled
  // state. The golden arrow sets the single target (last wins).
  jammer: {
    maxIntents: 1,
    persistent: true,
    sweep: 'set',
    flash: 'jamMarked',
    targetAt(world, deviceId, x, y) {
      let best = null, bd = HIT;
      for (const ff of world.ffs) {
        const d = pt_seg_dist([x, y], ff.p1, ff.p2);   // hit anywhere along the gate
        if (d < bd) { best = { id: ff.id, pos: ff.mid() }; bd = d; }
      }
      for (const n of Object.values(world.nodes)) {
        if (!kindIsJammable(n.kind)) continue;
        const d = dist([x, y], n.pos);
        if (d < bd) { best = { id: n.id, pos: n.pos }; bd = d; }
      }
      return best;
    },
    apply(world, deviceId, targetId) { world.set_jam(deviceId, targetId); },
    // Targets are force fields (hit at their midpoint, never self-blocking) and
    // jammable nodes (a mine). Reach uses the jammer ray profile from `origin`.
    candidates(world, deviceId, origin = world.nodes[deviceId]?.pos) {
      const out = [];
      for (const ff of world.ffs) {
        const pos = ff.mid();
        out.push({ id: ff.id, pos: [...pos],
          reachable: origin ? world.ray_clear(origin, pos, 'jammer',
            { excludeFieldId: ff.id }) : true });
      }
      for (const n of Object.values(world.nodes)) {
        if (n.spent || !kindIsJammable(n.kind)) continue;
        out.push({ id: n.id, pos: [...n.pos],
          reachable: origin ? world.ray_clear(origin, n.pos, 'jammer', {}) : true });
      }
      return out;
    },
    intentRays(world) {
      const out = [];
      for (const [jid, tid] of world.jam_links) {
        const jn = world.nodes[jid];
        const ff = world.field_by_id(tid);
        const to = ff ? ff.mid() : world.nodes[tid]?.pos;
        if (!jn || !to) continue;
        out.push({
          from: jn.pos,
          to,
          owners: [jid],
          key: `jam\u0000${jid}`,           // one intent per jammer
          remove: () => world.clear_jam(jid),
        });
      }
      return out;
    },
    clear(world, deviceId) { world.clear_jam(deviceId); },
  },
};

export function targetSpec(kind) {
  return TARGET_SPECS[kind] || null;
}

// Every stored intent ray across all targetable kinds, for click-deletion. Each
// carries a `key` (so a ray shared by two devices is offered once) and a bound
// `remove()`.
export function allIntentRays(world) {
  const out = [];
  const seen = new Set();
  for (const kind in TARGET_SPECS) {
    const spec = TARGET_SPECS[kind];
    if (!spec.intentRays) continue;
    for (const ray of spec.intentRays(world)) {
      // Wiring rays come from every relay spec over the same shared link set, so a
      // given link surfaces once per relay kind — collapse by key to offer it once.
      if (ray.key != null) { if (seen.has(ray.key)) continue; seen.add(ray.key); }
      out.push(ray);
    }
  }
  return out;
}
