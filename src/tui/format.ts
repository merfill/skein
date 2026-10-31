export function compactTokens(value: number): string {
  if (value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function compactDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function oneLine(text: string, width: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= width) return clean;
  if (width <= 1) return "…";
  return `${clean.slice(0, width - 1)}…`;
}

export function wrap(text: string, width: number): string[] {
  const clean = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const paragraph of clean) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word === "") continue;
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

export function shortId(id: string, width = 18): string {
  return id.length <= width ? id : `${id.slice(0, width - 1)}…`;
}
