// Parsing for `opencode run --format json`: one JSON event per line. A `step-finish`
// carries the LLM call's token usage (visible output, hidden reasoning, cache read); a
// `tool_use` is one tool call. Shared by the sandbox adapter (`opencode.ts`) and the
// Harbor report (`bench/agents_compare.ts`), so both count the same way.

export interface OpenCodeMetric {
  // LLM calls (`step-finish` events).
  steps: number;
  toolCalls: number;
  // Prompt tokens actually billed: fresh input + cache read.
  inputTokens: number;
  // Completion tokens: visible output + hidden reasoning (comparable with a run whose
  // `outputTokens` bundles reasoning).
  outputTokens: number;
  visibleOutput: number;
  reasoningTokens: number;
  cacheRead: number;
  // Prompt tokens per LLM call (fresh input + cache), for a context-size distribution.
  perCall: number[];
  byTool: Record<string, number>;
}

const STEP =
  /"type":"step-finish","tokens":\{"total":\d+,"input":(\d+),"output":(\d+),"reasoning":(\d+),"cache":\{"write":\d+,"read":(\d+)\}\}/;

const TOOL_NAME = /"type":"tool_use",.*?"tool":"([^"]+)"/;

export function parseOpenCodeStream(text: string): OpenCodeMetric {
  const metric: OpenCodeMetric = {
    steps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    visibleOutput: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    perCall: [],
    byTool: {},
  };
  for (const line of text.split("\n")) {
    if (line.includes('"type":"step-finish"')) {
      const match = STEP.exec(line);
      if (match !== null) {
        const input = Number(match[1]);
        const output = Number(match[2]);
        const reasoning = Number(match[3]);
        const cache = Number(match[4]);
        metric.steps += 1;
        metric.inputTokens += input + cache;
        metric.visibleOutput += output;
        metric.reasoningTokens += reasoning;
        metric.outputTokens += output + reasoning;
        metric.cacheRead += cache;
        metric.perCall.push(input + cache);
      }
    }
    if (line.includes('"type":"tool_use"')) {
      metric.toolCalls += 1;
      const name = TOOL_NAME.exec(line)?.[1];
      if (name !== undefined) metric.byTool[name] = (metric.byTool[name] ?? 0) + 1;
    }
  }
  return metric;
}
