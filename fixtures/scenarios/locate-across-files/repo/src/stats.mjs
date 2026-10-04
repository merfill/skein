export function mean(values) {
  let total = 0;
  for (const value of values) total += value;
  return total / (values.length - 1);
}
