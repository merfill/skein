import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Parsing of the model-API capture written by `api-log-proxy.mjs` (see opencode.ts). Unlike
// `opencode run --format json` (and opencode's session DB), which expose only tool/text
// events and token counts, the raw API traffic holds the exact prompt (system + messages +
// tools) and the streamed reasoning. Two shapes come out, mirroring Skein's own artifacts:
//   contexts.ndjson  — one line per model call: the context that was sent;
//   reasoning.ndjson — one line per model call: the reasoning that came back.

export interface CapturedContext {
  call: number;
  chars: number;
  model?: string;
  stream?: boolean;
  tools: string[];
  messages: { role: string; content: unknown }[];
}

export interface CapturedReasoning {
  call: number;
  status: number;
  finish?: string;
  reasoning: string;
  content: string;
  usage?: unknown;
  error?: string;
}

export interface ApiRequestLine {
  call: number;
  method?: string;
  url?: string;
  body: string;
}

export interface ApiResponseLine {
  call: number;
  status: number;
  body?: string;
  error?: string;
}

// The request body is the OpenAI chat-completions payload; keep the messages verbatim and
// the tool names. A non-JSON or unparsable body yields an empty context rather than throwing
// (the capture is evidence, not a gate).
export function parseRequestContext(body: string): Omit<CapturedContext, "call" | "chars"> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { tools: [], messages: [] };
  }
  const messages = Array.isArray(parsed.messages)
    ? (parsed.messages as { role?: unknown; content?: unknown }[]).map((m) => ({
        role: typeof m.role === "string" ? m.role : "unknown",
        content: m.content,
      }))
    : [];
  const tools = Array.isArray(parsed.tools)
    ? (parsed.tools as { function?: { name?: unknown }; name?: unknown }[]).map((t) =>
        typeof t.function?.name === "string" ? t.function.name : typeof t.name === "string" ? t.name : "unknown",
      )
    : [];
  const context: Omit<CapturedContext, "call" | "chars"> = { tools, messages };
  if (typeof parsed.model === "string") context.model = parsed.model;
  if (typeof parsed.stream === "boolean") context.stream = parsed.stream;
  return context;
}

// Reassemble the response: an SSE stream (`data: {...}` chunks) or a single JSON body /
// error. Reasoning arrives as `delta.reasoning` (some providers use `reasoning_content`);
// `usage`/`finish_reason` come from the terminal chunks.
export function parseResponseStream(body: string): Omit<CapturedReasoning, "call" | "status"> {
  let reasoning = "";
  let content = "";
  let finish: string | undefined;
  let usage: unknown;
  const text = body.trim();
  if (text === "") return { reasoning, content };
  const consume = (chunk: Record<string, unknown>): void => {
    const choices = chunk.choices as { delta?: Record<string, unknown>; finish_reason?: unknown }[] | undefined;
    const delta = choices?.[0]?.delta;
    if (delta !== undefined) {
      const r = delta.reasoning ?? delta.reasoning_content;
      if (typeof r === "string") reasoning += r;
      if (typeof delta.content === "string") content += delta.content;
    }
    const fr = choices?.[0]?.finish_reason;
    if (typeof fr === "string") finish = fr;
    if (chunk.usage != null) usage = chunk.usage;
  };
  if (text.startsWith("{")) {
    try {
      consume(JSON.parse(text) as Record<string, unknown>);
      return build(reasoning, content, finish, usage);
    } catch {
      // fall through to the SSE scan
    }
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      consume(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // a partial or non-JSON chunk is skipped
    }
  }
  return build(reasoning, content, finish, usage);
}

function build(reasoning: string, content: string, finish: string | undefined, usage: unknown): Omit<CapturedReasoning, "call" | "status"> {
  const out: Omit<CapturedReasoning, "call" | "status"> = { reasoning, content };
  if (finish !== undefined) out.finish = finish;
  if (usage != null) out.usage = usage;
  return out;
}

function readLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a torn line
    }
  }
  return out;
}

// Turn the raw capture (`api-requests.ndjson` / `api-responses.ndjson`) into the two
// readable artifacts. Returns what was written so a caller can report counts.
export function writeCapture(dir: string): { contexts: CapturedContext[]; reasoning: CapturedReasoning[] } {
  const requests = readLines(join(dir, "api-requests.ndjson")) as ApiRequestLine[];
  const responses = readLines(join(dir, "api-responses.ndjson")) as ApiResponseLine[];

  const contexts: CapturedContext[] = requests.map((r) => ({
    call: r.call,
    chars: r.body.length,
    ...parseRequestContext(r.body),
  }));
  const reasoning: CapturedReasoning[] = responses.map((r) => {
    const parsed = parseResponseStream(r.body ?? "");
    const line: CapturedReasoning = { call: r.call, status: r.status, ...parsed };
    if (r.error !== undefined) line.error = r.error;
    return line;
  });

  writeFileSync(join(dir, "contexts.ndjson"), contexts.map((c) => JSON.stringify(c)).join("\n") + (contexts.length > 0 ? "\n" : ""));
  writeFileSync(join(dir, "reasoning.ndjson"), reasoning.map((c) => JSON.stringify(c)).join("\n") + (reasoning.length > 0 ? "\n" : ""));
  return { contexts, reasoning };
}
