// Static provider catalog. Everything here speaks the OpenAI-compatible protocol; native
// Anthropic/Google adapters are deliberately out of scope for now. The catalog is offline and
// deterministic so `auth login`, `doctor` and the first-run flow work without a network call
// until the user asks for one.

export interface ProviderPreset {
  id: string;
  name: string;
  // Empty only for `custom`, whose endpoint the user supplies.
  baseURL: string;
  // Ordered credential sources. The first non-empty one wins.
  env: readonly string[];
  // A free tier or a local runtime. Used only for display and the first-run ordering.
  free?: boolean;
  // A local runtime: no key, discovered from `/v1/models`.
  local?: boolean;
  // A key is not required even though the provider is not local (Ollama-compatible proxy).
  apiKeyOptional?: boolean;
  signupURL?: string;
  // Suggested model; discovery via `/v1/models` is preferred.
  defaultModel?: string;
}

export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: "routerai",
    name: "RouterAI",
    baseURL: "https://routerai.ru/api/v1",
    env: ["ROUTERAI_API_KEY", "SKEIN_API_KEY"],
    signupURL: "https://routerai.ru/",
    defaultModel: "~deepseek/deepseek-v4-flash-latest",
  },
  {
    id: "openrouter",
    name: "OpenRouter (free models)",
    baseURL: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    free: true,
    signupURL: "https://openrouter.ai/settings/keys",
  },
  {
    id: "google",
    name: "Google AI Studio (Gemini, free tier)",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    free: true,
    signupURL: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    name: "Groq (free tier)",
    baseURL: "https://api.groq.com/openai/v1",
    env: ["GROQ_API_KEY"],
    free: true,
    signupURL: "https://console.groq.com/keys",
  },
  {
    id: "cerebras",
    name: "Cerebras (free tier)",
    baseURL: "https://api.cerebras.ai/v1",
    env: ["CEREBRAS_API_KEY"],
    free: true,
    signupURL: "https://cloud.cerebras.ai/",
  },
  {
    id: "mistral",
    name: "Mistral (free tier)",
    baseURL: "https://api.mistral.ai/v1",
    env: ["MISTRAL_API_KEY"],
    free: true,
    signupURL: "https://console.mistral.ai/api-keys",
  },
  {
    id: "github",
    name: "GitHub Models (free tier)",
    baseURL: "https://models.github.ai/inference",
    env: ["GITHUB_TOKEN", "GH_TOKEN"],
    free: true,
    signupURL: "https://github.com/settings/tokens",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    env: ["DEEPSEEK_API_KEY"],
    signupURL: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    signupURL: "https://platform.openai.com/api-keys",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseURL: "http://127.0.0.1:11434/v1",
    env: [],
    local: true,
    free: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseURL: "http://127.0.0.1:1234/v1",
    env: [],
    local: true,
    free: true,
  },
  {
    id: "vllm",
    name: "vLLM (local)",
    baseURL: "http://127.0.0.1:8000/v1",
    env: [],
    local: true,
    free: true,
  },
  {
    id: "custom",
    name: "Custom OpenAI-compatible endpoint",
    baseURL: "",
    env: ["SKEIN_API_KEY"],
  },
] as const;

export const LOCAL_PROVIDER_IDS: readonly string[] = PROVIDERS.filter(
  (provider) => provider.local === true,
).map((provider) => provider.id);

export const FREE_PROVIDER_IDS: readonly string[] = PROVIDERS.filter(
  (provider) => provider.free === true,
).map((provider) => provider.id);

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function requireProvider(id: string): ProviderPreset {
  const provider = providerById(id);
  if (provider === undefined) {
    throw new Error(`unknown provider: ${id} (known: ${PROVIDERS.map((p) => p.id).join(", ")})`);
  }
  return provider;
}

export function providerLabel(provider: ProviderPreset): string {
  const tags: string[] = [];
  if (provider.free === true) tags.push(provider.local === true ? "local, free" : "free tier");
  return tags.length > 0 ? `${provider.name} — ${tags.join(", ")}` : provider.name;
}
