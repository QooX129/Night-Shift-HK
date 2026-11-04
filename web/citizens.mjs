// +1 is the taxi's left-hand normal (-sin, cos) in map coordinates; -1 is the opposite side.
export function doorSide(state, car) {
  const point = state.boarding?.point;
  if (!point) return 1;
  const dx = point[0] - car.x, dy = point[1] - car.y;
  return -Math.sin(car.heading) * dx + Math.cos(car.heading) * dy >= 0 ? 1 : -1;
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
    if (motion.seeking_curb) distance = Math.min(length, distance + travel);
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
  if (state.customer) people.push({ id: "customer", point: state.customer, hailing: true });
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
    });
  }
  return people;
}
