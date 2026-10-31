import {
  InvalidToolInputError,
  NoSuchToolError,
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z, ZodError } from "zod";

import { loadSettings, type Settings } from "../config/settings";
import {
  createSessionTools,
  SESSION_REPORT_PROMPT,
  type SessionAgent,
  type SessionAgentDeps,
  type SessionReply,
  type SessionReporter,
  type SessionToolCall,
} from "../session/session_agent";
import type { ReadFile } from "../session/reading";
import { PROBE_KINDS, type SessionWorkspace } from "../session/session_workspace";
import type { SessionOperation } from "../session/types";

const unitSchema = z.object({ id: z.string() });
const readSchema = z.object({ path: z.string() });
const grepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
  from: z.number().int().positive().optional(),
});
const listSchema = z.object({
  path: z.string().optional(),
  include: z.string().optional(),
  from: z.number().int().positive().optional(),
});
const probeSchema = z.object({ kind: z.enum(PROBE_KINDS).optional() });
const stateSchema = z.object({ unit: z.string(), id: z.string() });
const turnsSchema = z.object({
  unit: z.string(),
  id: z.string(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});
const bodySchema = z.object({
  unit: z.string(),
  id: z.string(),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});
const searchSchema = z.object({
  unit: z.string(),
  pattern: z.string(),
  before: z.number().int().nonnegative().optional(),
  after: z.number().int().nonnegative().optional(),
  from: z.number().int().nonnegative().optional(),
  count: z.number().int().positive().optional(),
});
const respondSchema = z.object({ text: z.string() });
const startSchema = z.object({ text: z.string() });

const TOOL_DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "unit",
    description:
      "Return one unit's structure: states and closures, or a reading unit's path/size/observation. Call with the unit id from the trace (e.g. r1, reading:1).",
    schema: unitSchema,
  },
  {
    name: "read",
    description:
      "Read a file in one action. Returns a bounded preview, the full size and the address of a reading unit; for a small file the preview is the complete content, so answer from it. Use `body`/`search` on the reading unit for more. Do not start a task to read a file. Call with { path }.",
    schema: readSchema,
  },
  {
    name: "grep",
    description:
      "Search workspace file contents by regular expression (read-only). Use it to locate code — where something is defined or used — without starting a task. `path` scopes to a file or directory; `include` is a glob (e.g. \"**/*.ts\"); `from` pages matches (1-based). Returns `path:line: match` with a `continue from` cursor. This reads the live workspace; `search` searches a past unit's stored bodies instead.",
    schema: grepSchema,
  },
  {
    name: "list",
    description:
      "List workspace files (read-only), scoped by `path` (file or directory) and `include` glob; `from` pages the result. Returns a bounded JSON { root, total, from, returned, files, next }. Use it to see what exists without starting a task.",
    schema: listSchema,
  },
  {
    name: "probe",
    description:
      "Read one recorded toolchain fact (read-only; computed once per session). `kind`: environment (default: all groups), packages, interpreters, build, tests, vcs, tools, material, all. Use it to learn which compilers, package managers, interpreters or test tools exist before proposing a task.",
    schema: probeSchema,
  },
  {
    name: "state",
    description:
      "Return a state's plan: items, the current action, its result id and outcome (L2). Call with { unit, id }; unit is a task id (e.g. r1).",
    schema: stateSchema,
  },
  {
    name: "turns",
    description:
      "Return a state's turns: action, result id and outcome, plus the task agent's reasoning (bounded). Call with { unit, id, from?, to? }.",
    schema: turnsSchema,
  },
  {
    name: "body",
    description:
      "Return a result in full (or a line window) when its preview was cut off. `unit` is the unit that produced it; `id` is the result id printed with it. `start`/`end` select lines.",
    schema: bodySchema,
  },
  {
    name: "search",
    description:
      "Search a unit's observation bodies by regular expression. Call with { unit, pattern, before?, after?, from?, count? }.",
    schema: searchSchema,
  },
  {
    name: "respond",
    description:
      "Answer the user without changing any unit. Call with { text } when the message does not call for work.",
    schema: respondSchema,
  },
  {
    name: "start",
    description:
      "Start a new task. `text` is a self-contained reformulation of the user's request with the relevant context from the session traces. The previous task is not closed; it remains in the session.",
    schema: startSchema,
  },
];

export function sessionAgentTools(): ToolSet {
  const tools: ToolSet = {};
  for (const definition of TOOL_DEFINITIONS) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: definition.schema,
    });
  }
  return tools;
}

type NativeCall = { toolName: string; input: unknown; toolCallId: string };

function operationOf(name: string, input: unknown): SessionOperation | undefined {
  switch (name) {
    case "respond": {
      const value = respondSchema.parse(input);
      return { kind: "respond", text: value.text };
    }
    case "start": {
      const value = startSchema.parse(input);
      return { kind: "start", text: value.text };
    }
    default:
      return undefined;
  }
}

export function toSessionReply(calls: readonly NativeCall[]): SessionReply {
  for (const call of calls) {
    const operation = operationOf(call.toolName, call.input);
    if (operation !== undefined) return { operation };
  }
  if (calls.length === 0) return {};
  const toolCalls: SessionToolCall[] = calls.map((call) => ({
    name: call.toolName,
    args: (call.input as Record<string, unknown> | undefined) ?? {},
    callId: call.toolCallId,
  }));
  return { toolCalls };
}

export interface SessionModelOptions {
  settings?: Settings;
  onResponse?: (reply: { text: string; toolCalls: readonly NativeCall[] }) => void;
}

export interface SessionAgentDepsOptions extends SessionModelOptions {
  maxTurns?: number;
  surveyLimit?: number;
  readFile?: ReadFile;
  workspace?: SessionWorkspace;
}

// The report is one plain completion: the task trace is already deterministic, so it needs no
// tools and its output is not a session unit.
export function modelSessionReporter(
  model: LanguageModel,
  options: SessionModelOptions = {},
): SessionReporter {
  return async (input) => {
    const settings = options.settings ?? loadSettings();
    const result = await generateText({
      model,
      system: SESSION_REPORT_PROMPT,
      prompt: [
        `Original request:\n${input.utterance}`,
        `Task request:\n${input.request}`,
        `Task trace:\n${input.trace}`,
      ].join("\n\n"),
      maxRetries: 0,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
    });
    const text = result.text.trim();
    return text !== "" ? text : undefined;
  };
}

export function createSessionAgentDeps(
  model: LanguageModel,
  options: SessionAgentDepsOptions = {},
): SessionAgentDeps {
  const readFile = options.readFile ?? options.workspace?.read;
  return {
    agent: modelSessionAgent(model, options),
    tools: createSessionTools(readFile),
    report: modelSessionReporter(model, options),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.surveyLimit !== undefined ? { surveyLimit: options.surveyLimit } : {}),
    ...(readFile !== undefined ? { readFile } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
  };
}

export function modelSessionAgent(
  model: LanguageModel,
  options: SessionModelOptions = {},
): SessionAgent {
  return async (messages: ModelMessage[]) => {
    const settings = options.settings ?? loadSettings();
    let repair: ModelMessage | undefined;
    for (;;) {
      try {
        const result = await generateText({
          model,
          messages: repair === undefined ? messages : [...messages, repair],
          tools: sessionAgentTools(),
          stopWhen: stepCountIs(1),
          allowSystemInMessages: true,
          maxRetries: 0,
          temperature: settings.temperature,
          maxOutputTokens: settings.maxTokens,
        });
        const calls: NativeCall[] = result.toolCalls.map((call) => ({
          toolName: call.toolName,
          input: call.input,
          toolCallId: call.toolCallId,
        }));
        options.onResponse?.({ text: result.text, toolCalls: calls });
        const reasoning =
          result.reasoningText !== undefined && result.reasoningText !== ""
            ? { reasoning: result.reasoningText }
            : {};
        if (calls.length === 0) {
          // A plain-text answer is a valid session reply. Ask once for a tool call; if the
          // model insists on text, treat it as `respond` rather than dropping the answer.
          if (result.text.trim() !== "" && repair !== undefined) {
            return { operation: { kind: "respond", text: result.text }, ...reasoning };
          }
          if (repair === undefined) {
            repair = {
              role: "user",
              content:
                "You must call one of the session tools: a read-only `read`/`grep`/`list`/`probe`/`unit`/`state`/`turns`/`body`/`search` query, or an operation `respond`, `start`.",
            };
            continue;
          }
          return reasoning;
        }
        const reply = toSessionReply(calls);
        return {
          ...reply,
          ...(result.reasoningText !== undefined && result.reasoningText !== ""
            ? { reasoning: result.reasoningText }
            : {}),
        };
      } catch (error) {
        if (
          (NoSuchToolError.isInstance(error) ||
            InvalidToolInputError.isInstance(error) ||
            error instanceof ZodError) &&
          repair === undefined
        ) {
          repair = {
            role: "user",
            content:
              "Your tool call was invalid. Call one of the session tools with arguments matching its schema.",
          };
          continue;
        }
        throw error;
      }
    }
  };
}
