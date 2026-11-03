export interface Mention {
  // The `@` that opens the token.
  start: number;
  // The end of the token (whitespace or the string end).
  end: number;
  // The text between `@` and the cursor.
  query: string;
}

export interface CommandSpec {
  name: string;
  description: string;
}

export interface CompletionItem {
  label: string;
  detail?: string;
  value: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "new", description: "start a new session" },
  { name: "help", description: "show key help" },
  { name: "tasks", description: "open task history" },
  { name: "pause", description: "pause the running turn" },
  { name: "resume", description: "resume a paused turn" },
  { name: "cancel", description: "cancel the paused turn and roll back" },
  { name: "quit", description: "exit skein" },
  { name: "mouse", description: "toggle mouse capture" },
  { name: "verbose", description: "expand or collapse thoughts and tools" },
  { name: "status", description: "show the session summary" },
  { name: "clear", description: "clear the visible trace" },
];

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

// A mention is a whitespace-delimited token that starts with `@`; an email-like
// `foo@bar` is not a mention. `end` covers the whole token so accepting a
// suggestion replaces the query even when the cursor sits in its middle.
export function detectMention(input: string, cursor: number): Mention | undefined {
  const at = Math.max(0, Math.min(cursor, input.length));
  let start = at;
  while (start > 0 && !isSpace(input[start - 1] ?? "")) start -= 1;
  if (input[start] !== "@") return undefined;
  let end = at;
  while (end < input.length && !isSpace(input[end] ?? "")) end += 1;
  return { start, end, query: input.slice(start + 1, at) };
}

// Basename matches come first, then path matches; ties keep the shortest path,
// which keeps `src/app.ts` above `src/deep/nested/app.test.ts` for `ap`.
export function rankFiles(files: readonly string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  if (q === "") return files.slice(0, limit);
  const ranked: { file: string; score: number }[] = [];
  for (const file of files) {
    const path = file.toLowerCase();
    const base = path.slice(path.lastIndexOf("/") + 1);
    let score: number;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (path.startsWith(q)) score = 3;
    else if (path.includes(q)) score = 4;
    else continue;
    ranked.push({ file, score });
  }
  ranked.sort(
    (a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file),
  );
  return ranked.slice(0, limit).map((entry) => entry.file);
}

// The command menu is only for a bare `/name` line; once an argument is typed,
// Enter goes through the normal command parser.
export function detectSlash(input: string): { query: string } | undefined {
  const match = /^\/([A-Za-z-]*)$/.exec(input);
  return match === null ? undefined : { query: match[1] ?? "" };
}

export function rankCommands(query: string): CommandSpec[] {
  const q = query.toLowerCase();
  if (q === "") return [...COMMANDS];
  const starts: CommandSpec[] = [];
  const contains: CommandSpec[] = [];
  for (const command of COMMANDS) {
    if (command.name.startsWith(q)) starts.push(command);
    else if (command.name.includes(q)) contains.push(command);
  }
  return [...starts, ...contains];
}

export function replaceRange(
  input: string,
  start: number,
  end: number,
  text: string,
): { input: string; cursor: number } {
  return {
    input: `${input.slice(0, start)}${text}${input.slice(end)}`,
    cursor: start + text.length,
  };
}
