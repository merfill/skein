export function parseDuration(text) {
  let total = 0;
  for (const part of text.trim().split(/\s+/)) {
    if (part.endsWith("h")) {
      total += Number.parseInt(part, 10) * 3600;
    } else if (part.endsWith("m")) {
      total += Number.parseInt(part, 10);
    } else if (part.endsWith("s")) {
      total += Number.parseInt(part, 10);
    }
  }
  return total;
}
