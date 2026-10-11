import type { TapeMessage } from "../src/ir/project";

// The tape invariant, independent of any hand-written expectation: an `assistant.tool_calls`
// move is immediately answered by a `tool` message with the same id, every `tool` result
// answers a call, and call ids are unique. A `stop`/`decline`/legacy assistant text (no call)
// is terminal and allowed. Asserted on every projected tape (contract tests + random trees)
// so a structural regression fails loudly, not in the provider.
export function assertTapeContract(history: readonly TapeMessage[]): void {
  const answered = new Set<string>();
  for (let i = 0; i < history.length; i += 1) {
    const message = history[i]!;
    if (message.role === "tool") {
      if (message.callId === undefined) {
        throw new Error(`tape invariant: tool turn #${i} has no callId`);
      }
      const previous = history[i - 1];
      if (previous?.role !== "assistant" || previous.call?.id !== message.callId) {
        throw new Error(
          `tape invariant: tool result #${i} (${message.callId}) does not answer the preceding call`,
        );
      }
      answered.add(message.callId);
    }
    if (message.role === "assistant" && message.call !== undefined) {
      if (answered.has(message.call.id)) {
        throw new Error(`tape invariant: duplicate call id ${message.call.id}`);
      }
      const next = history[i + 1];
      if (next?.role !== "tool" || next.callId !== message.call.id) {
        throw new Error(`tape invariant: call ${message.call.id} (#${i}) has no tool result`);
      }
    }
  }
}
