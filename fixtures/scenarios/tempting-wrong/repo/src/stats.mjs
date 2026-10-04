export function median(values) {
  const n = values.length;
  if (n === 0) throw new Error("median of empty sequence");
  if (n % 2 === 1) return values[Math.floor(n / 2)];
  return (values[n / 2] + values[n / 2 - 1]) / 2;
}
