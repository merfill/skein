function advance(sum, values, i, size) {
  return sum + values[i] - values[i - size];
}

export function maxWindowSum(values, size) {
  if (size <= 0 || size > values.length) return 0;
  let sum = 0;
  for (let i = 0; i < size; i += 1) sum += values[i];
  let best = sum;
  for (let i = size; i < values.length; i += 1) {
    sum = advance(sum, values, i, size);
    if (sum > best) best = sum;
  }
  return best;
}
