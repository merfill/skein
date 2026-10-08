import type { SandboxTask } from "../task";

// terminal-bench `fix-git`, ported on the task's own Docker image: the image already has
// `/app/personal-site` (a git repo whose good commit is not on master) and
// `/app/resources/patch_files/`. The agent must recover the lost commit and merge it; the
// check compares the site files against the reference. No host install and no setup replay.
export const fixGit: SandboxTask = {
  id: "fix-git",
  image: "alexgshaw/fix-git:20251031",
  workdir: "/app/personal-site",
};
