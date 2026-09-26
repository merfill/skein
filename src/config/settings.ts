import "dotenv/config";

export interface Settings {
  apiUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort: string;
  maxTurns: number;
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
    maxTokens: num(env.SKEIN_MAX_TOKENS, 4096),
    reasoningEffort: env.SKEIN_REASONING_EFFORT ?? "none",
    maxTurns: num(env.SKEIN_MAX_TURNS, 24),
    live: (env.SKEIN_LIVE ?? "false").toLowerCase() === "true",
  };
}
