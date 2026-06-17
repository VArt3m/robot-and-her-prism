// kinds: source / connector / receiver / button / and / or / mine / rewirer / jammer
export class Node {
  constructor(nid, kind, pos, { color = null, label = null, fill_time = 0.0, fuse = null } = {}) {
    this.id = nid;
    this.kind = kind;
    this.pos = [pos[0], pos[1]];
    this.color = color;
    this.label = label;
    this.fill_time = fill_time;
    this.elevated = false;   // connector: true only while placed on a box
    // Mine state: fuse seconds (programmable), whether it is counting down
    // (begins on the first drop), and whether a jammer has frozen it.
    this.fuse = fuse;
    this.fuse_running = false;
    this.disabled = false;   // frozen by a jammer (mine / future targets)
  }
}

export class Wall {
  constructor(p1, p2) {
    this.p1 = [p1[0], p1[1]];
    this.p2 = [p2[0], p2[1]];
  }
}

export class Barrier {
  constructor(p1, p2, kind) {
    this.p1 = [p1[0], p1[1]];
    this.p2 = [p2[0], p2[1]];
    this.kind = kind;
  }
}

export class ForceField {
  constructor(fid, p1, p2) {
    this.id = fid;
    this.p1 = [p1[0], p1[1]];
    this.p2 = [p2[0], p2[1]];
    this.is_open = false;
    // Forced inert by one or more live jammer rays. A disabled field is "down":
    // passable to the player, to light beams, and to jammer rays, and the logic
    // that would otherwise open or shut it is ignored — it stays disabled until
    // every jam ray reaching it is gone. `is_open` still tracks the logic result
    // underneath, so behaviour resumes the instant the jam clears.
    this.disabled = false;
  }

  // Effectively non-blocking? True when logic has opened it OR a jammer holds it
  // disabled. Everything that used to test `!is_open` for solidity should test
  // `!is_passable()` so a jammed field reads as down everywhere.
  is_passable() {
    return this.is_open || this.disabled;
  }

  mid() {
    return [(this.p1[0] + this.p2[0]) / 2, (this.p1[1] + this.p2[1]) / 2];
  }
}
