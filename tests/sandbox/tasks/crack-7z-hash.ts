import type { SandboxTask } from "../task";

// terminal-bench `crack-7z-hash`: recover a 7z password with John the Ripper (built in the
// image). No Python in the image, so the verifier runs on the host tools.
export const crack7zHash: SandboxTask = {
  id: "crack-7z-hash",
  image: "alexgshaw/crack-7z-hash:20251031",
  checkIn: "host",
  // The task installs p7zip and a Perl module at solve time, as Harbor allows.
  network: "bridge",
};
