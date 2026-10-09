// A standalone allowlist forward proxy (see proxy.ts). It runs as its OWN process because
// the caller blocks on `spawnSync` while the agent runs: an in-process proxy would never
// get an event-loop turn to answer. Permits CONNECT/absolute-form HTTP only for the
// allowlisted hosts; everything else is refused (403). Prints `PROXY_PORT <n>` once bound.

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const args = process.argv.slice(2);
const allow = [];
let port = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--allow") allow.push(args[++i]);
  else if (args[i] === "--port") port = Number(args[++i]);
}

const allowed = allow.map((host) => host.toLowerCase());
const hostAllowed = (host) => {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
};

const server = createServer((req, res) => {
  res.on("error", () => {});
  req.on("error", () => {});
  let target;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (!hostAllowed(target.hostname)) {
    res.writeHead(403).end("blocked");
    return;
  }
  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port === "" ? 80 : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  upstream.on("error", () => res.writeHead(502).end("upstream error"));
  req.pipe(upstream);
});

server.on("clientError", (_error, socket) => socket.destroy());

server.on("connect", (req, clientSocket, head) => {
  // A client that closes as soon as it reads the response must not crash the proxy.
  clientSocket.on("error", () => {});
  const [host = "", portStr = "443"] = (req.url ?? "").split(":");
  if (!hostAllowed(host)) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = connect(Number(portStr), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  console.log(`PROXY_PORT ${typeof address === "object" && address !== null ? address.port : port}`);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
// A proxy must survive a client resetting a connection (curl closing early, etc.).
process.on("uncaughtException", (error) => console.error("proxy uncaught:", error.message));
