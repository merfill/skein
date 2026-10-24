import { describe, expect, it } from "vitest";

import { parseNetworkMode, resolveNetwork } from "./sandbox/network";

describe("sandbox network modes", () => {
  it("parses only `off` as off, everything else as on", () => {
    expect(parseNetworkMode("on")).toBe("on");
    expect(parseNetworkMode("off")).toBe("off");
    expect(parseNetworkMode(undefined)).toBe("on");
    expect(parseNetworkMode("bogus")).toBe("on");
  });

  it("detaches the network from the agent only", () => {
    expect(resolveNetwork("on")).toEqual({ requested: "on", agent: "bridge", verifier: "bridge" });
    expect(resolveNetwork("off")).toEqual({ requested: "off", agent: "none", verifier: "bridge" });
  });
});
