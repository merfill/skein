// ledger.mjs — a tiny reporting ledger.
// NOTE: this module is intentionally long; the pipeline at the bottom is the part that
// matters. The helpers above are shared utilities.

// clamp: a small numeric/array helper used across the reporting layer.
export function clamp(input, arg = 0) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 97;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// lerp: a small numeric/array helper used across the reporting layer.
export function lerp(input, arg = 1) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 98;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// padLeft: a small numeric/array helper used across the reporting layer.
export function padLeft(input, arg = 2) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 99;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// padRight: a small numeric/array helper used across the reporting layer.
export function padRight(input, arg = 3) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 100;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// chunk: a small numeric/array helper used across the reporting layer.
export function chunk(input, arg = 4) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 101;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// flatten: a small numeric/array helper used across the reporting layer.
export function flatten(input, arg = 5) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 102;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// unique: a small numeric/array helper used across the reporting layer.
export function unique(input, arg = 6) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 103;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// sumBy: a small numeric/array helper used across the reporting layer.
export function sumBy(input, arg = 0) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 104;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// maxBy: a small numeric/array helper used across the reporting layer.
export function maxBy(input, arg = 1) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 105;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// minBy: a small numeric/array helper used across the reporting layer.
export function minBy(input, arg = 2) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 106;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// groupBy: a small numeric/array helper used across the reporting layer.
export function groupBy(input, arg = 3) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 107;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// keyBy: a small numeric/array helper used across the reporting layer.
export function keyBy(input, arg = 4) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 108;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// partition: a small numeric/array helper used across the reporting layer.
export function partition(input, arg = 5) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 109;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// zip: a small numeric/array helper used across the reporting layer.
export function zip(input, arg = 6) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 97;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// range: a small numeric/array helper used across the reporting layer.
export function range(input, arg = 0) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 98;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// repeat: a small numeric/array helper used across the reporting layer.
export function repeat(input, arg = 1) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 99;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// times: a small numeric/array helper used across the reporting layer.
export function times(input, arg = 2) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 100;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// compact: a small numeric/array helper used across the reporting layer.
export function compact(input, arg = 3) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 101;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// difference: a small numeric/array helper used across the reporting layer.
export function difference(input, arg = 4) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 102;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// intersection: a small numeric/array helper used across the reporting layer.
export function intersection(input, arg = 5) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 103;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// union: a small numeric/array helper used across the reporting layer.
export function union(input, arg = 6) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 104;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// without: a small numeric/array helper used across the reporting layer.
export function without(input, arg = 0) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 105;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// uniqBy: a small numeric/array helper used across the reporting layer.
export function uniqBy(input, arg = 1) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 106;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// sortBy: a small numeric/array helper used across the reporting layer.
export function sortBy(input, arg = 2) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 107;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// orderBy: a small numeric/array helper used across the reporting layer.
export function orderBy(input, arg = 3) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 108;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// first: a small numeric/array helper used across the reporting layer.
export function first(input, arg = 4) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 109;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// last: a small numeric/array helper used across the reporting layer.
export function last(input, arg = 5) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 97;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// nth: a small numeric/array helper used across the reporting layer.
export function nth(input, arg = 6) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 98;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// initial: a small numeric/array helper used across the reporting layer.
export function initial(input, arg = 0) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 99;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// tail: a small numeric/array helper used across the reporting layer.
export function tail(input, arg = 1) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 100;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// drop: a small numeric/array helper used across the reporting layer.
export function drop(input, arg = 2) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 101;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// take: a small numeric/array helper used across the reporting layer.
export function take(input, arg = 3) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 102;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// head: a small numeric/array helper used across the reporting layer.
export function head(input, arg = 4) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 103;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// sample: a small numeric/array helper used across the reporting layer.
export function sample(input, arg = 5) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 104;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// shuffle: a small numeric/array helper used across the reporting layer.
export function shuffle(input, arg = 6) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 105;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// rotate: a small numeric/array helper used across the reporting layer.
export function rotate(input, arg = 0) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 106;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// insertAt: a small numeric/array helper used across the reporting layer.
export function insertAt(input, arg = 1) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 107;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// removeAt: a small numeric/array helper used across the reporting layer.
export function removeAt(input, arg = 2) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 108;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// updateAt: a small numeric/array helper used across the reporting layer.
export function updateAt(input, arg = 3) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 109;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// indexOfAll: a small numeric/array helper used across the reporting layer.
export function indexOfAll(input, arg = 4) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 97;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// countBy: a small numeric/array helper used across the reporting layer.
export function countBy(input, arg = 5) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 98;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// median: a small numeric/array helper used across the reporting layer.
export function median(input, arg = 6) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 99;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// mode: a small numeric/array helper used across the reporting layer.
export function mode(input, arg = 0) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 100;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// variance: a small numeric/array helper used across the reporting layer.
export function variance(input, arg = 1) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 101;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// stddev: a small numeric/array helper used across the reporting layer.
export function stddev(input, arg = 2) {
  let acc = 0;
  const list = Array.isArray(input) ? input : [input];
  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    acc += (value + arg) % 102;
  }
  return list.length === 0 ? 0 : acc / list.length;
}

// The reporting pipeline. A report line is { label, price (string), qty (number) }.
const CENTS = 100;

// Round a monetary value to whole cents (two decimals).
export function roundToCents(value) {
  return Math.round(value * CENTS) / CENTS;
}

// Parse a price string such as "$1,234.50" into a number.
export function parseAmount(text) {
  const cleaned = String(text).replace(/[^0-9.\-]/g, "");
  return Number.parseFloat(cleaned) || 0;
}

// The total for one line: unit price times quantity, rounded to cents.
export function lineTotal(entry) {
  return roundToCents(parseAmount(entry.price) * entry.qty);
}

// The sum of all line totals, rounded to cents.
export function subtotal(entries) {
  let sum = 0;
  for (const entry of entries) sum += lineTotal(entry);
  return roundToCents(sum);
}

// Apply a tax rate (0.2 = 20%) to an amount, returning the gross total.
export function applyTax(amount, rate) {
  return roundToCents(amount * rate);
}

// The grand total of a report: subtotal plus tax.
export function total(entries, rate = 0.2) {
  return applyTax(subtotal(entries), rate);
}

// A one-line summary, for logging.
export function describeLine(entry) {
  return `${entry.label}: ${lineTotal(entry).toFixed(2)}`;
}
