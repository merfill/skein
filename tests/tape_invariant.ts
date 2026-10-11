import type { TapeMessage } from "../src/ir/project";

// The tape invariant, independent of any hand-written expectation: an `assistant.tool_calls`
// move — a single `call` or a batch `calls` — is immediately answered by one `tool` message
// per call, in the same order; every `tool` result answers a call; call ids are unique. A
// `stop`/`decline`/legacy assistant text (no call) is terminal and allowed. Asserted on every
// projected tape (contract tests + random trees) so a structural regression fails loudly, not
// in the provider.
export function assertTapeContract(history: readonly TapeMessage[]): void {
  const answered = new Set<string>();
  let i = 0;
  while (i < history.length) {
    const message = history[i]!;
    if (message.role !== "assistant") {
      if (message.role === "tool") {
        throw new Error(`tape invariant: tool result #${i} does not answer a preceding call`);
      }
      i += 1;
      continue;
    }
    const calls = message.calls ?? (message.call !== undefined ? [message.call] : []);
    if (calls.length === 0) {
      i += 1;
      continue;
    }
    for (const call of calls) {
      if (answered.has(call.id)) throw new Error(`tape invariant: duplicate call id ${call.id}`);
    }
    for (let j = 0; j < calls.length; j += 1) {
      const result = history[i + 1 + j];
      if (result?.role !== "tool" || result.callId !== calls[j]!.id) {
        throw new Error(`tape invariant: call ${calls[j]!.id} (#${i}) has no tool result in order`);
      }
      answered.add(calls[j]!.id);
    }
    i += 1 + calls.length;
  }
}
