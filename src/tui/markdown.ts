import { lexer } from "marked";
import type { Token, Tokens } from "marked";
import stringWidth from "string-width";

import { highlightCode } from "./highlight";
import { theme } from "./theme";
import type { TraceLine, TraceSpan } from "./types";

type Style = Omit<TraceSpan, "text">;

function merge(base: Style, extra: Style): Style {
  return { ...base, ...extra };
}

function pushSpan(spans: TraceSpan[], text: string, style: Style): void {
  if (text !== "") spans.push({ text, ...style });
}

function inlineSpans(tokens: readonly Token[] | undefined, base: Style = {}): TraceSpan[] {
  if (tokens === undefined) return [];
  const spans: TraceSpan[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        spans.push(...inlineSpans((token as Tokens.Strong).tokens, merge(base, { bold: true })));
        break;
      case "em":
        spans.push(...inlineSpans((token as Tokens.Em).tokens, merge(base, { italic: true })));
        break;
      case "del":
        spans.push(
          ...inlineSpans((token as Tokens.Del).tokens, merge(base, { dim: true, strikethrough: true })),
        );
        break;
      case "codespan":
        pushSpan(spans, (token as Tokens.Codespan).text, merge(base, { color: theme.code }));
        break;
      case "link": {
        const link = token as Tokens.Link;
        spans.push(
          ...inlineSpans(link.tokens, merge(base, { color: theme.link, underline: true })),
        );
        if (link.href !== "" && link.href !== link.text) {
          pushSpan(spans, ` (${link.href})`, merge(base, { dim: true }));
        }
        break;
      }
      case "image":
        pushSpan(spans, (token as Tokens.Image).text, merge(base, { dim: true }));
        break;
      case "br":
        pushSpan(spans, " ", base);
        break;
      case "escape":
        pushSpan(spans, (token as Tokens.Escape).text, base);
        break;
      case "html":
        pushSpan(spans, (token as Tokens.HTML).text.replace(/<[^>]+>/g, ""), base);
        break;
      case "text": {
        const nested = (token as Tokens.Text).tokens;
        spans.push(
          ...(nested !== undefined
            ? inlineSpans(nested, base)
            : [{ text: (token as Tokens.Text).text, ...base }]),
        );
        break;
      }
      default:
        pushSpan(spans, token.raw, base);
        break;
    }
  }
  return spans;
}

function spansText(spans: readonly TraceSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function line(spans: TraceSpan[]): TraceLine {
  return { text: spansText(spans), spans };
}

function blank(out: TraceLine[]): void {
  if (out.length > 0 && out[out.length - 1]?.text.trim() !== "") {
    out.push({ text: " ", spans: [{ text: " " }] });
  }
}

interface Word {
  text: string;
  style: Style;
  space: boolean;
  newline: boolean;
}

function words(spans: readonly TraceSpan[]): Word[] {
  const out: Word[] = [];
  for (const span of spans) {
    const style = { ...span };
    delete (style as Partial<TraceSpan>).text;
    const parts = span.text.split(/(\s+)/);
    for (const part of parts) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) {
        out.push({ text: " ", style, space: true, newline: part.includes("\n") });
      } else {
        out.push({ text: part, style, space: false, newline: false });
      }
    }
  }
  return out;
}

function splitWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let size = 0;
  for (const char of Array.from(word)) {
    const charWidth = stringWidth(char);
    if (size + charWidth > width && current !== "") {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += charWidth;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

function wrapSpans(
  spans: readonly TraceSpan[],
  width: number,
  firstPrefix = "",
  restPrefix = "",
  base: Style = {},
): TraceLine[] {
  const out: TraceLine[] = [];
  let current: TraceSpan[] = [];
  let currentWidth = 0;
  let prefix = firstPrefix;
  const start = (): void => {
    current = [];
    currentWidth = stringWidth(prefix);
    if (prefix !== "") pushSpan(current, prefix, base);
  };
  const flush = (): void => {
    if (current.length > 0) out.push(line(current));
    prefix = restPrefix;
    start();
  };
  start();
  let pendingSpace = false;
  for (const word of words(spans)) {
    if (word.newline) {
      flush();
      pendingSpace = false;
      continue;
    }
    if (word.space) {
      pendingSpace = true;
      continue;
    }
    const wordWidth = stringWidth(word.text);
    const spaceWidth = pendingSpace && currentWidth > stringWidth(prefix) ? 1 : 0;
    if (currentWidth + spaceWidth + wordWidth > width) {
      flush();
      pendingSpace = false;
    }
    if (pendingSpace && currentWidth > stringWidth(prefix)) {
      pushSpan(current, " ", word.style);
      currentWidth += 1;
    }
    pendingSpace = false;
    if (wordWidth <= Math.max(1, width - currentWidth)) {
      pushSpan(current, word.text, word.style);
      currentWidth += wordWidth;
      continue;
    }
    for (const chunk of splitWord(word.text, Math.max(1, width - currentWidth))) {
      if (currentWidth + stringWidth(chunk) > width) flush();
      pushSpan(current, chunk, word.style);
      currentWidth += stringWidth(chunk);
    }
  }
  if (current.length > 0) out.push(line(current));
  return out;
}

function fitSpans(spans: readonly TraceSpan[], width: number): TraceSpan[] {
  const out: TraceSpan[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= width) break;
    const room = width - used;
    if (stringWidth(span.text) <= room) {
      out.push(span);
      used += stringWidth(span.text);
      continue;
    }
    let text = "";
    let size = 0;
    for (const char of Array.from(span.text)) {
      const charWidth = stringWidth(char);
      if (size + charWidth > room) break;
      text += char;
      size += charWidth;
    }
    if (text !== "") out.push({ ...span, text });
    used += size;
    break;
  }
  return out;
}

function prefixed(lines: readonly TraceLine[], prefix: string, dim: boolean, width: number): TraceLine[] {
  return lines.map((item) => {
    const spans: TraceSpan[] = [{ text: prefix, dim }];
    for (const span of item.spans ?? [{ text: item.text }]) {
      spans.push(dim && span.dim !== false ? { ...span, dim: true } : span);
    }
    return line(fitSpans(spans, width));
  });
}

function tableLines(table: Tokens.Table, width: number, indent: number): TraceLine[] {
  const header = table.header.map((cell) => inlineSpans(cell.tokens));
  const rows = table.rows.map((row) => row.map((cell) => inlineSpans(cell.tokens)));
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const widths: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    const cells = [header[column], ...rows.map((row) => row[column])];
    widths.push(
      Math.max(
        1,
        ...cells.map((cell) => (cell === undefined ? 0 : stringWidth(spansText(cell)))),
      ),
    );
  }
  const total = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, columns - 1) * 3;
  if (total > width) {
    const room = Math.max(1, Math.floor((width - Math.max(0, columns - 1) * 3) / columns));
    widths.fill(room);
  }
  const renderRow = (cells: TraceSpan[][], bold: boolean): TraceLine => {
    const spans: TraceSpan[] = [{ text: " ".repeat(indent) }];
    for (let column = 0; column < columns; column += 1) {
      if (column > 0) spans.push({ text: " │ ", dim: true });
      const cell = cells[column] ?? [];
      const room = widths[column] ?? 1;
      const textWidth = stringWidth(spansText(cell));
      const padded = bold
        ? cell.map((span) => ({ ...span, bold: true }))
        : cell.map((span) => ({ ...span }));
      spans.push(...fitSpans(padded, room));
      if (textWidth < room) spans.push({ text: " ".repeat(room - textWidth) });
    }
    return line(fitSpans(spans, width));
  };
  const out: TraceLine[] = [renderRow(header, true)];
  const rule = widths.map((value) => "─".repeat(value)).join("─┼─");
  out.push({ text: `${" ".repeat(indent)}${rule}`, dim: true });
  for (const row of rows) out.push(renderRow(row, false));
  return out;
}

function renderBlocks(
  tokens: readonly Token[],
  width: number,
  out: TraceLine[],
  indent = 0,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        blank(out);
        const pad = indent + Math.max(0, Math.min(heading.depth, 3) - 1) * 2;
        const style: Style = {
          bold: true,
          color: heading.depth === 1 ? theme.headingStrong : theme.heading,
        };
        out.push(
          ...wrapSpans(
            inlineSpans(heading.tokens, style),
            width,
            " ".repeat(pad),
            " ".repeat(pad),
            style,
          ),
        );
        break;
      }
      case "paragraph":
      case "text": {
        const paragraph = token as Tokens.Paragraph;
        blank(out);
        out.push(
          ...wrapSpans(
            inlineSpans(paragraph.tokens),
            width,
            " ".repeat(indent),
            " ".repeat(indent),
          ),
        );
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        blank(out);
        list.items.forEach((item, index) => {
          const bullet = list.ordered ? `${Number(list.start || 1) + index}.` : "•";
          const check = item.task === true ? (item.checked === true ? "[x] " : "[ ] ") : "";
          const marker = `${" ".repeat(indent)}${bullet} ${check}`;
          const body = item.tokens.filter((child) => child.type !== "list");
          out.push(
            ...wrapSpans(
              inlineSpans(body),
              width,
              marker,
              " ".repeat(marker.length),
            ),
          );
          const nested = item.tokens.filter((child) => child.type === "list");
          if (nested.length > 0) renderBlocks(nested, width, out, indent + 2);
        });
        blank(out);
        break;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        blank(out);
        const inner: TraceLine[] = [];
        renderBlocks(quote.tokens, Math.max(10, width - 2), inner, 0);
        out.push(...prefixed(inner, "│ ", true, width));
        blank(out);
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        blank(out);
        for (const spans of highlightCode(code.lang, code.text)) {
          out.push(line(fitSpans([{ text: " ".repeat(indent) }, ...spans], width)));
        }
        blank(out);
        break;
      }
      case "table": {
        blank(out);
        out.push(...tableLines(token as Tokens.Table, width, indent));
        blank(out);
        break;
      }
      case "hr": {
        blank(out);
        out.push({ text: "─".repeat(Math.max(10, width - indent)), dim: true });
        blank(out);
        break;
      }
      case "html": {
        const html = token as Tokens.HTML;
        blank(out);
        out.push(
          ...wrapSpans(
            [{ text: html.text.replace(/<[^>]+>/g, "") }],
            width,
            " ".repeat(indent),
            " ".repeat(indent),
          ),
        );
        break;
      }
      case "space":
        blank(out);
        break;
      case "br":
        out.push({ text: " ", spans: [{ text: " " }] });
        break;
      default:
        blank(out);
        out.push(
          ...wrapSpans([{ text: token.raw }], width, " ".repeat(indent), " ".repeat(indent)),
        );
        break;
    }
  }
}

export function markdownLines(text: string, width: number): TraceLine[] {
  const out: TraceLine[] = [];
  renderBlocks(lexer(text), Math.max(20, width), out);
  while (out.length > 0 && out[out.length - 1]?.text.trim() === "") out.pop();
  return out;
}
