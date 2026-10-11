import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRequestContext, parseResponseStream, writeCapture } from "./sandbox/opencode-capture";

// The opencode comparison needs the model's exact context and reasoning, which `opencode run
// --format json` and its session DB do not expose; the logging API proxy captures the raw
// traffic, and these pure parsers turn it into contexts.ndjson / reasoning.ndjson. This test
// pins the wire shapes offline (no model, no Docker).

const SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"","reasoning":"Let me "}}]}',
  'data: {"choices":[{"index":0,"delta":{"content":"","reasoning":"think."}}]}',
  'data: {"choices":[{"index":0,"delta":{"content":"0.05","reasoning":null}}]}',
  'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"total_tokens":10,"completion_tokens_details":{"reasoning_tokens":4}}}',
  "data: [DONE]",
  "",
].join("\n\n");

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skein-opencode-capture-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("opencode API capture", () => {
  it("reassembles reasoning, content, finish and usage from an SSE stream", () => {
    const r = parseResponseStream(SSE);
    expect(r.reasoning).toBe("Let me think.");
    expect(r.content).toBe("0.05");
    expect(r.finish).toBe("stop");
    expect(r.usage).toEqual({ total_tokens: 10, completion_tokens_details: { reasoning_tokens: 4 } });
  });

  it("does not throw on a JSON error body", () => {
    const r = parseResponseStream('{"error":{"message":"Not Found"}}');
    expect(r.reasoning).toBe("");
    expect(r.content).toBe("");
  });

  it("reads the messages and the tool names from a chat-completions request", () => {
    const body = JSON.stringify({
      model: "~deepseek/deepseek-v4-flash-latest",
      stream: true,
      messages: [
        { role: "system", content: "you are an agent" },
        { role: "user", content: "fix it" },
      ],
      tools: [
        { type: "function", function: { name: "bash" } },
        { type: "function", function: { name: "edit" } },
      ],
    });
    const c = parseRequestContext(body);
    expect(c.model).toBe("~deepseek/deepseek-v4-flash-latest");
    expect(c.stream).toBe(true);
    expect(c.tools).toEqual(["bash", "edit"]);
    expect(c.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("writes contexts.ndjson and reasoning.ndjson from the raw capture", () => {
    const dir = tempDir();
    const request = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
    writeFileSync(join(dir, "api-requests.ndjson"), JSON.stringify({ call: 0, method: "POST", url: "/api/v1/chat/completions", body: request }) + "\n");
    writeFileSync(join(dir, "api-responses.ndjson"), JSON.stringify({ call: 0, status: 200, body: SSE }) + "\n");

    const captured = writeCapture(dir);
    expect(captured.contexts).toHaveLength(1);
    expect(captured.reasoning).toHaveLength(1);

    const contexts = readFileSync(join(dir, "contexts.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const reasoning = readFileSync(join(dir, "reasoning.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(contexts[0].call).toBe(0);
    expect(contexts[0].chars).toBe(request.length);
    expect(reasoning[0].reasoning).toBe("Let me think.");
    expect(reasoning[0].status).toBe(200);
  });
});
