export function pmax(values) {
  let best = 0;
  for (const value of values) {
    if (value > best) best = value;
  }
  return best;
}
