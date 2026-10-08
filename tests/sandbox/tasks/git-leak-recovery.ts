import type { SandboxTask } from "../task";

// terminal-bench `git-leak-recovery`: the image's `challenge-setup.sh` builds `/app/repo`
// with a secret in an unreachable object; the agent recovers it and purges the history.
export const gitLeakRecovery: SandboxTask = {
  id: "git-leak-recovery",
  image: "alexgshaw/git-leak-recovery:20251031",
  // The image ships git but no Python; the verifier is Python, so it runs on the host tools.
  checkIn: "host",
};
