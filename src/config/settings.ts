import "dotenv/config";

export interface Settings {
  apiUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // When a structured call is cut by the completion cap, retry with a higher cap
  // (up to `maxTokensCeiling`, at most `maxTokensBumps` times) before falling back to
  // plain JSON parsing (docs/testing_ru.md §8.1).
  maxTokensCeiling: number;
  maxTokensBumps: number;
  reasoningEffort: string;
  maxTurns: number;
  // Cap on a foreground `run`; a long verifier build may need more than the default
  // (background jobs are uncapped and polled instead, docs/tools.md §4.7).
  runTimeoutMs: number;
  live: boolean;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    apiUrl: env.SKEIN_API_URL ?? "https://routerai.ru/api/v1",
    apiKey: env.SKEIN_API_KEY ?? "",
    model: env.SKEIN_MODEL ?? "~deepseek/deepseek-v4-flash-latest",
    temperature: num(env.SKEIN_TEMPERATURE, 0.1),
    // Reasoning is on by default (see `client.ts`): the reasoning tokens share the
    // completion budget, so the base cap is larger than a plain-answer run needs.
    maxTokens: num(env.SKEIN_MAX_TOKENS, 8192),
    maxTokensCeiling: num(env.SKEIN_MAX_TOKENS_CEILING, 32768),
    maxTokensBumps: num(env.SKEIN_MAX_TOKENS_BUMPS, 2),
    reasoningEffort: env.SKEIN_REASONING_EFFORT ?? "high",
    maxTurns: num(env.SKEIN_MAX_TURNS, 24),
    runTimeoutMs: num(env.SKEIN_RUN_TIMEOUT_MS, 120_000),
    live: (env.SKEIN_LIVE ?? "false").toLowerCase() === "true",
  };
}
