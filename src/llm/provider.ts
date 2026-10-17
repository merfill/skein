// The provider seam. skein speaks the OpenAI Chat Completions wire format, but the model's
// hidden reasoning is NOT part of that spec: every vendor names it differently (`reasoning` for
// RouterAI here, `reasoning_content` for DeepSeek/Qwen, `thinking`/`thought` elsewhere). An
// adapter is the one place that name is known — the engine journals reasoning and the
// projection renders it, provider-agnostically (`src/ir/project.ts`, `docs/ir_semantics.md §7`).
//
// `openaiCompatible` is the first adapter (RouterAI and any backend that echoes DeepSeek's
// `reasoning_content`); a different vendor adds its own implementation without touching the
// engine or the projection.

// The subset of the outbound Chat Completions body the adapter reads/writes.
export interface WireBody {
  messages?: {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    reasoning_content?: unknown;
  }[];
  [key: string]: unknown;
}

// The subset of the inbound response the adapter reads/writes.
export interface WireResponse {
  choices?: {
    message?: {
      reasoning?: unknown;
      reasoning_content?: unknown;
      [key: string]: unknown;
    };
  }[];
  [key: string]: unknown;
}

// The subset of an inbound SSE chunk (streaming) the adapter reads/writes. The reasoning
// rides on the delta; the rest of the chunk is passed through verbatim.
export interface WireChunk {
  choices?: {
    delta?: {
      reasoning?: unknown;
      reasoning_content?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
}

export interface ReasoningAdapter {
  // Outbound: move the reasoning the projection carried on an assistant turn into the
  // provider's own field, so the model sees its previous reasoning on the next call.
  toWire(body: WireBody): void;
  // Inbound (non-streaming): copy the provider's reasoning field onto the canonical
  // `reasoning_content`, the name langchain-openai maps into `additional_kwargs`. The
  // original field is left in place.
  fromWire(json: WireResponse): void;
  // Inbound (streaming): copy the provider's per-delta reasoning onto `reasoning_content`,
  // the name langchain-openai maps when it assembles the streamed message
  // (`converters/completions.ts`). The original field is left in place.
  fromChunk(chunk: WireChunk): void;
}

// RouterAI returns `reasoning`; most OpenAI-compatible backends return `reasoning_content`.
// The request side is `reasoning_content` for all of them.
export const openaiCompatible: ReasoningAdapter = {
  toWire(body) {
    for (const message of body.messages ?? []) {
      if (message.role !== "assistant") continue;
      const calls = message.tool_calls;
      // Only an assistant TOOL turn carries reasoning this way. In skein such a turn has no
      // visible text (the projection renders it as `content: ""` + tool_calls), so any text on
      // it is the state's reasoning; the state markers / closure lines have text but no calls
      // and are left untouched. The field is sent even when the reasoning is empty: some
      // subcontractors behind the meta-provider require `reasoning_content` back on every
      // assistant tool turn in thinking mode ("must be passed back to the API").
      if (!Array.isArray(calls) || calls.length === 0) continue;
      if (typeof message.content === "string") {
        message.reasoning_content = message.content;
        message.content = "";
      }
    }
  },
  fromWire(json) {
    for (const choice of json.choices ?? []) {
      const message = choice?.message;
      if (message === undefined) continue;
      if (message.reasoning_content === undefined && typeof message.reasoning === "string") {
        message.reasoning_content = message.reasoning;
      }
    }
  },
  fromChunk(chunk) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice?.delta;
      if (delta === undefined) continue;
      if (delta.reasoning_content === undefined && typeof delta.reasoning === "string") {
        delta.reasoning_content = delta.reasoning;
      }
    }
  },
};
