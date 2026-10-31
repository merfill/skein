import type { Element, Nodes, Root } from "hast";
import { common, createLowlight } from "lowlight";

import { theme } from "./theme";
import type { TraceSpan } from "./types";

const lowlight = createLowlight(common);

const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  objc: "objectivec",
  sql: "sql",
  dockerfile: "dockerfile",
  console: "bash",
  text: "",
};

type Style = Omit<TraceSpan, "text">;

const S = theme.syntax;
const STYLES: Record<string, Style> = {
  keyword: { color: S.keyword, bold: true },
  "selector-tag": { color: S.keyword, bold: true },
  built_in: { color: S.builtin },
  type: { color: S.type },
  literal: { color: S.literal },
  number: { color: S.number },
  string: { color: S.string },
  regexp: { color: S.string },
  symbol: { color: S.literal },
  comment: { color: S.comment },
  quote: { color: S.comment },
  doctag: { color: S.comment },
  meta: { color: S.comment },
  function: { color: S.function },
  title: { color: S.function },
  class: { color: S.type },
  "title-class": { color: S.type },
  variable: { color: S.variable },
  "variable-language": { color: S.keyword },
  attr: { color: S.attr },
  attribute: { color: S.attr },
  property: { color: S.property },
  tag: { color: S.tag },
  name: { color: S.tag },
  selector: { color: S.string },
  params: { color: S.variable },
  operator: { color: S.operator },
  punctuation: { color: S.punctuation },
  addition: { color: S.addition },
  deletion: { color: S.deletion },
};

function classNames(node: Nodes): string[] {
  if (node.type !== "element") return [];
  const raw = (node as Element).properties?.className;
  return Array.isArray(raw) ? raw.map(String) : [];
}

function styleFor(classes: readonly string[], inherited: Style): Style {
  let style: Style = { ...inherited };
  for (const raw of classes) {
    if (!raw.startsWith("hljs-")) continue;
    const name = raw.slice(5).replaceAll("_", "-");
    const direct = STYLES[name];
    if (direct !== undefined) style = { ...style, ...direct };
    const [head] = name.split("-");
    const fallback = head !== undefined ? STYLES[head] : undefined;
    if (fallback !== undefined) style = { ...style, ...fallback };
  }
  return style;
}

function appendText(lines: TraceSpan[][], text: string, style: Style): void {
  const parts = text.split("\n");
  parts.forEach((part, index) => {
    if (part !== "") lines[lines.length - 1]?.push({ text: part, ...style });
    if (index < parts.length - 1) lines.push([]);
  });
}

function walk(nodes: readonly Nodes[], lines: TraceSpan[][], inherited: Style): void {
  for (const node of nodes) {
    if (node.type === "text") {
      appendText(lines, node.value, inherited);
    } else if (node.type === "element") {
      const style = styleFor(classNames(node), inherited);
      walk(node.children as Nodes[], lines, style);
    }
  }
}

function plain(code: string): TraceSpan[][] {
  return code.split("\n").map((line) => (line === "" ? [] : [{ text: line }]));
}

export function highlightCode(language: string | undefined, code: string): TraceSpan[][] {
  if (language === undefined || language.trim() === "") return plain(code);
  const lang = ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  if (lang === "") return plain(code);
  try {
    const tree: Root = lowlight.highlight(lang, code);
    const lines: TraceSpan[][] = [[]];
    walk(tree.children as Nodes[], lines, {});
    if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
    return lines.length > 0 ? lines : plain(code);
  } catch {
    return plain(code);
  }
}
