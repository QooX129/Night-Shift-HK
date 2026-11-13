export const HAIL_BUBBLE = {
  x: 2, y: 0, width: 80, height: 42, radius: 12,
  tailWidth: 20, tailHeight: 12, canvasWidth: 128, canvasHeight: 64,
};

export function drawHailBubble(context, text) {
  const { x, y, width, height, radius, tailWidth, tailHeight } = HAIL_BUBBLE;
  const centreX = x + width / 2, centreY = y + height / 2;
  const bottom = y + height;
  context.fillStyle = "#ffe8c0dc";
  context.strokeStyle = "#ec6630";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.moveTo(centreX - tailWidth / 2, bottom);
  context.lineTo(centreX, bottom + tailHeight);
  context.lineTo(centreX + tailWidth / 2, bottom);
  context.fill(); context.stroke();
  context.fillStyle = "#382515da";
  context.font = "bold 22px system-ui";
  context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText(text, centreX, centreY);
}

// Map Y points down: +1 (-sin, cos) is right; -1 is the taxi's left.
export function doorSide(state, car) {
  if (state.boarding?.alighting) return -1;
  const point = state.boarding?.point;
  if (!point) return 1;
  const dx = point[0] - car.x, dy = point[1] - car.y;
  return -Math.sin(car.heading) * dx + Math.cos(car.heading) * dy >= 0 ? 1 : -1;
}

export function describeTraits(traits = {}, messages) {
  return [
    traits.luggage ? `${messages.largeLuggage} ×${traits.luggage}` : "",
    traits.bag ? messages[traits.bag] : "",
    traits.animal ? `${messages[traits.animal]} ×1` : "",
    traits.wheelchair ? messages.wheelchair : "",
  ].filter(Boolean).join(" · ");
}

export function describeCharges(charges = {}, traits = {}, messages) {
  return [
    charges.luggage ? `${messages.largeLuggage} ×${traits.luggage} · HK$ ${charges.luggage}` : "",
    charges.animal ? `${messages[traits.animal]} ×1 · HK$ ${charges.animal}` : "",
    charges.booking ? `${messages.phoneBooking} · HK$ ${charges.booking}` : "",
  ].filter(Boolean).join("; ");
}

export function peopleOnMap(state, car) {
  const people = (state.citizens ?? []).map(person => {
    const motion = person.motion;
    if (!motion?.points?.length) return person;
    const points = motion.points;
    const lengths = points.slice(1).map((b, i) => Math.hypot(b[0] - points[i][0], b[1] - points[i][1]));
    const length = lengths.reduce((a, b) => a + b, 0);
    if (!length) return person;
    const travel = Math.max(0, state.elapsed - state.citizens_at) * motion.speed;
    let distance = motion.distance, direction = motion.direction;
    if (motion.returning_to_walk) distance = Math.max(0, distance - travel);
    else if (motion.seeking_curb) distance = Math.min(length, distance + travel);
    else if (motion.speed > 0) {
      const phase = ((direction > 0 ? distance : 2 * length - distance) + travel) % (2 * length);
      distance = phase < length ? phase : 2 * length - phase;
      direction = phase < length ? 1 : -1;
    }
    let index = 0;
    while (index < lengths.length - 1 && distance > lengths[index]) distance -= lengths[index++];
    const a = points[index], b = points[index + 1], t = lengths[index] ? distance / lengths[index] : 0;
    return { ...person, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      heading: Math.atan2((b[1] - a[1]) * direction, (b[0] - a[0]) * direction),
      walking: motion.speed > 0 && (!motion.seeking_curb || distance < length),
      walkSpeed: motion.speed };
  });
  if (state.customer) people.push({ id: "customer", point: state.customer, hailing: true,
    ...(state.traits ? { traits: state.traits } : {}) });
  if (state.boarding) {
    const { point, starts, ends, alighting } = state.boarding;
    const progress = Math.max(0, Math.min(1, (state.elapsed - starts) / (ends - starts)));
    const side = doorSide(state, car);
    const door = [car.x - Math.sin(car.heading) * 1.2 * side, car.y + Math.cos(car.heading) * 1.2 * side];
    // Boarding walks curb -> door then shrinks inside; alighting grows at the door then walks to the curb.
    const t = alighting ? 1 - progress : progress;
    const walk = Math.min(1, t / 0.8);
    people.push({
      id: alighting ? "alighting" : "boarding", point: [point[0] + (door[0] - point[0]) * walk,
        point[1] + (door[1] - point[1]) * walk],
      hailing: false, boarding: true, scale: t > 0.8 ? (1 - t) / 0.2 : 1,
      traits: state.boarding.traits ?? state.traits,
      heading: Math.atan2(alighting ? point[1] - door[1] : door[1] - point[1],
        alighting ? point[0] - door[0] : door[0] - point[0]),
      walking: t < .8, walkSpeed: 1.1,
    });
  }
  return people;
}

export function drawCitizen(context, person, elapsed) {
  const c = context, traits = person.traits ?? {};
  const swing = person.walking ? Math.sin(elapsed * (person.walkSpeed ?? 1.1) * 7) * .6 : 0;
  c.strokeStyle = person.hailing ? "#ffac6e" : "#c3d1dc";
  c.fillStyle = person.boarding ? "#92d7b6" : person.hailing ? "#ffac6e" : "#c3d1dc";
  c.lineWidth = 1; c.lineCap = "round";
  c.beginPath(); c.moveTo(0, -0.5); c.lineTo(0, 1.5);
  c.moveTo(-1.5, 1 + (traits.wheelchair ? 0 : swing)); c.lineTo(0, 0);
  c.lineTo(2, person.hailing ? -3 : 1 - (traits.wheelchair ? 0 : swing));
  c.moveTo(0, 1); c.lineTo(-.8, traits.wheelchair ? 1.8 : 2.5 + swing);
  c.moveTo(0, 1); c.lineTo(.8, traits.wheelchair ? 1.8 : 2.5 - swing); c.stroke();
  c.beginPath(); c.arc(0, -1.6, 1, 0, Math.PI * 2); c.fill();
  if (traits.wheelchair) {
    c.strokeStyle = "#91a4aa"; c.lineWidth = .4;
    c.beginPath(); c.arc(-.6, 1.8, 1.2, 0, Math.PI * 2);
    c.moveTo(-1.6, 0); c.lineTo(-1.6, 1.5); c.lineTo(1.3, 1.5); c.lineTo(1.8, 2.8);
    const spin = person.walking ? elapsed * (person.walkSpeed ?? 1.1) * 3 : 0;
    c.moveTo(-.6, 1.8); c.lineTo(-.6 + Math.cos(spin), 1.8 + Math.sin(spin)); c.stroke();
    c.beginPath(); c.arc(1.8, 2.8, .35, 0, Math.PI * 2); c.stroke();
  }
  c.lineWidth = .25; c.fillStyle = "#bb8556"; c.strokeStyle = "#e9cf9a";
  for (let i = 0; i < (traits.luggage ?? 0); i++) {
    const x = i === 0 ? -3.1 : 1.8;
    c.fillRect(x, .2, 1.3, 2); c.strokeRect(x, .2, 1.3, 2);
    c.strokeRect(x + .35, -.4, .6, .6);
  }
  if (traits.bag) {
    c.fillStyle = traits.bag === "backpack" ? "#729b80" : "#c48bb3";
    const x = traits.bag === "backpack" ? -1.1 : 1.8;
    const y = traits.bag === "handbag" && traits.luggage === 2 ? -1.1 : .2;
    c.fillRect(x, y, 1, 1.2); c.strokeRect(x + .2, y - .4, .6, .4);
  }
  if (traits.animal === "bird") {
    c.strokeStyle = "#e9cf9a"; c.strokeRect(3, .3, 1.8, 1.8);
    for (const x of [3.5, 4, 4.5]) {
      c.beginPath(); c.moveTo(x, .3); c.lineTo(x, 2.1); c.stroke();
    }
    c.fillStyle = "#f5c65a"; c.beginPath(); c.arc(3.9, 1.2, .4, 0, Math.PI * 2); c.fill();
  } else if (traits.animal) {
    c.strokeStyle = "#e9cf9a";
    c.beginPath(); c.moveTo(1.8, 1); c.lineTo(4.2, 2); c.stroke();
    c.fillStyle = traits.animal === "cat" ? "#cfb4a1" : "#a9794f";
    c.fillRect(3.8, 1.8, 1.6, .8);
    c.beginPath(); c.arc(5.3, 1.7, .55, 0, Math.PI * 2); c.fill();
    c.strokeStyle = c.fillStyle; c.lineWidth = .3;
    c.beginPath();
    c.moveTo(4, 2.5); c.lineTo(4 + swing * .3, 3);
    c.moveTo(5, 2.5); c.lineTo(5 - swing * .3, 3);
    c.moveTo(3.8, 2); c.lineTo(3.2, traits.animal === "cat" ? 1 : 1.7);
    if (traits.animal === "cat") {
      c.moveTo(5, 1.3); c.lineTo(5, .8); c.lineTo(5.3, 1.3);
      c.moveTo(5.4, 1.3); c.lineTo(5.7, .8); c.lineTo(5.7, 1.5);
    }
    c.stroke();
  }
}
