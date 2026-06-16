// kinds: source / connector / receiver / button / and / or
export class Node {
  constructor(nid, kind, pos, { color = null, label = null, fill_time = 0.0 } = {}) {
    this.id = nid;
    this.kind = kind;
    this.pos = [pos[0], pos[1]];
    this.color = color;
    this.label = label;
    this.fill_time = fill_time;
    this.elevated = false;   // connector: true only while placed on a box
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
  }

  mid() {
    return [(this.p1[0] + this.p2[0]) / 2, (this.p1[1] + this.p2[1]) / 2];
  }
}
