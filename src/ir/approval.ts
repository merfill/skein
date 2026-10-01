import type { EventInput } from "./events";

export function userAcceptance(
  claimIds: readonly string[],
  verdict: "pass" | "fail" = "pass",
  note?: string,
): EventInput {
  return {
    type: "record_check",
    actor: "user",
    command: note ?? "user acceptance",
    verdict,
    output: "",
    claimIds: [...claimIds],
  };
}
