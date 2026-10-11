// A standalone logging reverse proxy for the model API (see api-log-proxy.ts). It runs as
// its OWN process because the caller blocks on `spawnSync` while the agent runs: an
// in-process proxy would never get an event-loop turn to answer. opencode is pointed at
// this proxy via its `baseURL` (plain HTTP); the proxy forwards each request to the real
// HTTPS API and tees both the request body (the exact context: messages + tools) and the
// response body (the SSE stream, where `delta.reasoning` holds the hidden reasoning) to
// the run directory. Prints `PROXY_PORT <n>` once bound.

import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let upstream = "";
let dir = "";
let port = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--upstream") upstream = args[++i];
  else if (args[i] === "--dir") dir = args[++i];
  else if (args[i] === "--port") port = Number(args[++i]);
}
const reqFile = join(dir, "api-requests.ndjson");
const resFile = join(dir, "api-responses.ndjson");
let call = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const id = call++;
    appendFileSync(reqFile, JSON.stringify({ call: id, method: req.method, url: req.url, body }) + "\n");
    // `host` would point at the proxy, `accept-encoding` could gzip the body we capture.
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["accept-encoding"];
    const up = httpsRequest(upstream + req.url, { method: req.method, headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      const out = [];
      proxyRes.on("data", (c) => {
        out.push(c);
        res.write(c);
      });
      proxyRes.on("end", () => {
        res.end();
        appendFileSync(resFile, JSON.stringify({ call: id, status: proxyRes.statusCode, body: Buffer.concat(out).toString("utf8") }) + "\n");
      });
    });
    up.on("error", (error) => {
      res.writeHead(502).end();
      appendFileSync(resFile, JSON.stringify({ call: id, status: 502, error: error.message }) + "\n");
    });
    up.write(body);
    up.end();
  });
});

server.on("clientError", (_error, socket) => socket.destroy());
server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  console.log(`PROXY_PORT ${typeof address === "object" && address !== null ? address.port : port}`);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
