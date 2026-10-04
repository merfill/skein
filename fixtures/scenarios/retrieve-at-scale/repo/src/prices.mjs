const STEP = 3;
const OFFSET = 7;
const BROKEN_FROM = 600;

export function priceAt(index) {
  const step = index >= BROKEN_FROM ? STEP - 1 : STEP;
  return index * step + OFFSET;
}
