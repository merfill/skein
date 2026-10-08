import type { SandboxTask } from "../task";

// terminal-bench `password-recovery`: carve a fragmented secret out of a disk image. The
// image (Ubuntu + forensics tools) has no Python, so the verifier runs on the host tools.
export const passwordRecovery: SandboxTask = {
  id: "password-recovery",
  image: "alexgshaw/password-recovery:20251031",
  checkIn: "host",
};
