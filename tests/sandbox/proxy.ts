import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A tiny forward proxy that permits only the hosts in `allow` and refuses everything else.
// It exists to give a live agent the model API while denying it the rest of the internet
// ("no internet" that still reaches the LLM): the agent's `curl`/`git`/`wget` honor
// `HTTP(S)_PROXY`, so their fetches are refused transparently, while opencode's own model
// calls (which honor the same env — verified) pass through to `routerai.ru`.
//
// The proxy runs as a separate process (`proxy-server.mjs`): the caller blocks on
// `spawnSync` for the whole agent run, so an in-process proxy would never answer. It is
// spawned on 0.0.0.0 and advertised at `advertisedHost` (e.g. `host.docker.internal`).

export interface AllowlistProxy {
  // The URL to advertise to clients, e.g. `http://host.docker.internal:41234`.
  url: string;
  close(): Promise<void>;
}

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "proxy-server.mjs");

export function startAllowlistProxy(allow: readonly string[], advertisedHost: string): Promise<AllowlistProxy> {
  const args = [SERVER];
  for (const host of allow) args.push("--allow", host);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise<AllowlistProxy>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += String(chunk);
      const match = /PROXY_PORT (\d+)/.exec(buffer);
      if (match === null) return;
      child.stdout?.off("data", onData);
      const port = match[1];
      resolve({
        url: `http://${advertisedHost}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) {
              done();
              return;
            }
            child.once("exit", () => done());
            child.kill("SIGTERM");
          }),
      });
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`allowlist proxy exited early (${code})`)));
  });
}
