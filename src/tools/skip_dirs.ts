// Directories that are VCS metadata, build output or caches, not the agent's source tree.
// The workspace listing/grep and the checkpoint walk share this set, so a snapshot never
// spends minutes hashing `.git`, `.venv`, `out`, caches, etc.
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".skein",
  "_build",
  "target",
  "build",
  "out",
  "obj",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  ".venv",
  "venv",
  ".tox",
  ".gradle",
  ".next",
  ".nuxt",
  ".terraform",
]);
