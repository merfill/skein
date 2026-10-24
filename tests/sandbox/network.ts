// Network modes for a sandbox run. `on` is Harbor's default (the agent may reach the
// network); `off` removes it from the agent only. The verifier always keeps its network:
// every task's `tests/test.sh` bootstraps its own runtime (apt/uv/pip), and Harbor runs that
// script with network on. Keeping the two phases separate is what makes `off` honest without
// breaking acceptance.

export type NetworkMode = "on" | "off";
export type NetworkAttachment = "bridge" | "none" | "host";

export interface NetworkPlan {
  // What the CLI asked for.
  requested: NetworkMode;
  // What the agent's container actually has.
  agent: NetworkAttachment;
  // What the verifier has. It is independent of the agent: test.sh installs its runtime.
  verifier: NetworkAttachment;
}

export function parseNetworkMode(value: string | undefined): NetworkMode {
  return value === "off" ? "off" : "on";
}

export function resolveNetwork(requested: NetworkMode): NetworkPlan {
  return {
    requested,
    agent: requested === "on" ? "bridge" : "none",
    verifier: "bridge",
  };
}
