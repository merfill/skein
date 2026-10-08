import type { SandboxTask } from "../task";

// terminal-bench `openssl-selfsigned-cert`: generate a self-signed cert and a combined PEM
// under `/app/ssl`. The image carries openssl; the verifier shells out to it.
export const opensslSelfsignedCert: SandboxTask = {
  id: "openssl-selfsigned-cert",
  image: "alexgshaw/openssl-selfsigned-cert:20251031",
};
