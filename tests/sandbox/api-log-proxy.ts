import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The logging reverse proxy for the model API (see `api-log-proxy.mjs`). opencode is given
// this proxy as its `baseURL`, so every model call lands here: the request body is the
// exact context (system + messages + tools), the response body carries the streamed
// reasoning. It runs in a separate process because the harness blocks on `spawnSync` for
// the whole agent run.

export interface ApiLogProxy {
  // The URL to advertise to opencode, e.g. `http://host.docker.internal:41234`.
  url: string;
  close(): Promise<void>;
}

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "api-log-proxy.mjs");

export function startApiLogProxy(upstream: string, dir: string, advertisedHost: string): Promise<ApiLogProxy> {
  const child = spawn(process.execPath, [SERVER, "--upstream", upstream, "--dir", dir], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise<ApiLogProxy>((resolve, reject) => {
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
    child.once("exit", (code) => reject(new Error(`api-log proxy exited early (${code})`)));
  });
}
