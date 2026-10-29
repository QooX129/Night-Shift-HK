const directions = {
  gas: { group: "straight", angle: 0, sides: ["left", "right"] },
  left: { group: "left", angle: -Math.PI / 2, sides: ["brake", "gas"] },
  right: { group: "right", angle: Math.PI / 2, sides: ["gas", "brake"] },
  brake: { group: "uturn", angle: Math.PI, sides: ["right", "left"] },
};

export function junctionDirection(angle) {
  const degrees = angle * 180 / Math.PI;
  return Math.abs(degrees) > 150 ? "uturn" : Math.abs(degrees) < 35 ? "straight" : degrees < 0 ? "left" : "right";
}

export function junctionShortcuts(options) {
  const shortcuts = new Map(), keys = { gas: "W", left: "A", right: "D", brake: "S" };
  const record = (edge, label, cost) => {
    if (edge && (!shortcuts.has(edge) || cost < shortcuts.get(edge).cost)) shortcuts.set(edge, { label, cost });
  };
  for (const [main, direction] of Object.entries(directions)) {
    const input = new JunctionInput({ releaseGrace: 0 });
    record(input.press("main", main, options), keys[main], 1);
    for (const side of direction.sides) {
      input.reset();
      input.press("main", main, options);
      const count = input.options.length > 3 ? input.options.length : 1;
      for (let tap = 1; tap <= count; tap++) {
        record(input.press("side", side, options),
          `${keys[main]} + ${keys[side]}${tap > 1 ? ` ×${tap}` : ""}`, 1 + tap);
        input.release("side");
      }
    }
  }
  return new Map([...shortcuts].map(([edge, shortcut]) => [edge, shortcut.label]));
}

export class JunctionInput {
  constructor({ releaseGrace = 150 } = {}) {
    this.releaseGrace = releaseGrace;
    this.reset();
  }
  reset() {
    this.keys = new Map();
    this.main = null;
    this.options = [];
    this.allOptions = [];
    this.index = -1;
    this.preview = null;
    this.sideTaps = new Map();
    this.releaseDeadline = null;
  }
  press(key, action, options, now = performance.now()) {
    this.advance(now);
    this.releaseDeadline = null;
    if (this.keys.has(key)) return this.preview;
    this.allOptions = options;
    const alreadyHeld = [...this.keys.values()].includes(action);
    this.keys.set(key, action);
    if (!this.main || this.options.length < 2) {
      this.main = action;
      this.sideTaps = new Map();
      const direction = directions[action];
      const relative = option => Math.atan2(Math.sin(option.angle - direction.angle),
        Math.cos(option.angle - direction.angle));
      this.options = options.filter(option => option.direction === direction.group)
        .sort((a, b) => relative(a) - relative(b));
      this.index = this.options.length >= 3 ? Math.floor((this.options.length - 1) / 2)
        : this.options.reduce((best, option, i) =>
          Math.abs(relative(option)) < Math.abs(relative(this.options[best])) ? i : best, 0);
      this.preview = this.options[this.index]?.edge ?? null;
    } else if (!alreadyHeld && action !== this.main) {
      const side = directions[this.main].sides.indexOf(action);
      if (side >= 0) {
        const taps = (this.sideTaps.get(action) ?? 0) + 1;
        this.sideTaps.set(action, taps);
        if (this.options.length > 3 && taps > 1) {
          this.index = (this.index + (side === 0 ? -1 : 1) + this.options.length) % this.options.length;
          this.preview = this.options[this.index].edge;
        } else if (this.options.length >= 2) {
          this.index = side === 0 ? 0 : this.options.length - 1;
          this.preview = this.options[this.index].edge;
        }
      }
    }
    const held = new Set(this.keys.values());
    const [left, right] = directions[this.main].sides;
    const opposite = { gas: "brake", brake: "gas", left: "right", right: "left" }[this.main];
    if (this.options.length >= 2 && (held.has(opposite) || (held.has(left) && held.has(right)))) this.preview = null;
    return this.preview;
  }
  advance(now = performance.now()) {
    if (this.releaseDeadline === null || now < this.releaseDeadline) return;
    this.releaseDeadline = null;
    this.rebuild();
  }
  rebuild() {
    const remaining = [...this.keys], options = this.allOptions;
    const main = this.main, index = this.index, taps = this.sideTaps;
    this.reset();
    for (const [heldKey, heldAction] of remaining) this.press(heldKey, heldAction, options);
    if (this.main === main) {
      this.index = index;
      this.sideTaps = taps;
    }
  }
  release(key, now = performance.now()) {
    this.advance(now);
    const action = this.keys.get(key);
    if (!this.keys.delete(key)) return null;
    if (this.keys.size) {
      if ([...this.keys.values()].includes(action)) return null;
      if (this.options.length >= 2 && this.preview !== null && this.releaseGrace > 0) {
        this.releaseDeadline ??= now + this.releaseGrace;
        return null;
      }
      this.rebuild();
      return null;
    }
    const selected = this.preview;
    this.reset();
    return selected;
  }
}
