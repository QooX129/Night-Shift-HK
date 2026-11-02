// +1 is the taxi's left-hand normal (-sin, cos) in map coordinates; -1 is the opposite side.
export function doorSide(state, car) {
  const point = state.boarding?.point;
  if (!point) return 1;
  const dx = point[0] - car.x, dy = point[1] - car.y;
  return -Math.sin(car.heading) * dx + Math.cos(car.heading) * dy >= 0 ? 1 : -1;
}

export function peopleOnMap(state, car) {
  const people = [...(state.citizens ?? [])];
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
