import { LOCAL_PROVIDER_IDS, providerById, type ProviderPreset } from "./presets";

// The probes are plain OpenAI-compatible HTTP calls. They are the only place the provider layer
// touches the network, and every call is injectable so the offline tests use a mock fetch.

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface ProbeOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ChatProbe {
  ok: boolean;
  status: number;
  latencyMs: number;
  text?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const LOCAL_TIMEOUT_MS = 800;

function baseURLOf(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bodyText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
}

export function describeHttpError(status: number, body: string): string {
  const snippet = body.trim() === "" ? "" : `: ${body.trim()}`;
  if (status === 401 || status === 403) {
    return `authentication failed (${status}) — check the API key${snippet}`;
  }
  if (status === 404) {
    return `endpoint or model not found (404) — check the base URL and model id${snippet}`;
  }
  if (status === 429) {
    return `rate limited (429) — retry later or use another model${snippet}`;
  }
  if (status === 400) {
    return `provider rejected the request (400) — check the model id${snippet}`;
  }
  if (status >= 500) {
    return `provider error (${status})${snippet}`;
  }
  return `provider returned ${status}${snippet}`;
}

function headers(apiKey: string | undefined): Record<string, string> {
  return {
    Accept: "application/json",
    ...(apiKey !== undefined && apiKey !== "" ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

function modelIds(body: unknown): string[] {
  const data =
    Array.isArray(body)
      ? body
      : typeof body === "object" && body !== null
        ? (body as { data?: unknown }).data
        : undefined;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry === "string" && entry !== "") ids.push(entry);
    else if (typeof entry === "object" && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && id !== "") ids.push(id);
    }
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function listModels(
  baseURL: string,
  options: ProbeOptions = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await request(
      `${baseURLOf(baseURL)}/models`,
      { method: "GET", headers: headers(options.apiKey) },
      timeoutMs,
      fetchImpl,
    );
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw new Error(`cannot reach the provider: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await bodyText(response);
    throw new ProviderHttpError(describeHttpError(response.status, body), response.status, body);
  }
  return modelIds(await response.json().catch(() => undefined));
}

// A one-token chat is the cheapest end-to-end check that the key and model work. It is only
// called from `skein doctor` (and an explicit login prompt), never on a normal turn.
export async function testChat(
  baseURL: string,
  model: string,
  options: ProbeOptions = {},
): Promise<ChatProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await request(
      `${baseURLOf(baseURL)}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...headers(options.apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
          max_tokens: 1,
          stream: false,
        }),
      },
      timeoutMs,
      fetchImpl,
    );
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw new Error(`cannot reach the provider: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    const body = await bodyText(response);
    throw new ProviderHttpError(describeHttpError(response.status, body), response.status, body);
  }
  const body = (await response.json().catch(() => undefined)) as
    | { choices?: { message?: { content?: unknown } }[] }
    | undefined;
  const content = body?.choices?.[0]?.message?.content;
  return {
    ok: true,
    status: response.status,
    latencyMs,
    ...(typeof content === "string" ? { text: content } : {}),
  };
}

export interface LocalProvider {
  preset: ProviderPreset;
  models: string[];
}

// Best-effort probe of the local runtimes. A short timeout keeps the first-run notice quick
// when nothing is running.
export async function detectLocalProviders(
  options: ProbeOptions = {},
): Promise<LocalProvider[]> {
  const results = await Promise.all(
    LOCAL_PROVIDER_IDS.map(async (id) => {
      const preset = providerById(id);
      if (preset === undefined) return undefined;
      try {
        const models = await listModels(preset.baseURL, {
          ...options,
          timeoutMs: options.timeoutMs ?? LOCAL_TIMEOUT_MS,
        });
        return models.length > 0 ? { preset, models } : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((entry): entry is LocalProvider => entry !== undefined);
}
