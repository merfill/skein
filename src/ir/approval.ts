import type { EventInput } from "./events";

export function userAcceptance(
  goalIds: readonly string[],
  verdict: "pass" | "fail" | "inconclusive" = "pass",
  note?: string,
  under?: readonly string[],
): EventInput {
  return {
    type: "record_check",
    actor: "user",
    command: note ?? "user acceptance",
    verdict,
    output: "",
    targets: [...goalIds],
    ...(under !== undefined ? { under: [...under] } : {}),
  };
}
