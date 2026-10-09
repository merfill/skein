import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A terminal-bench task, ported to run WITHOUT Docker: the harness materializes the task's
// environment into a temp root and runs the agent in a `bwrap` namespace (`container.ts`),
// then scores it with the task's own verifier. The task's files (instruction, setup,
// verifier) are read from the local Harbor cache, never copied into the repository (the
// tasks carry a benchmark canary).
//
//   { id, files?, setup?, check?, mountPoint? }
//
// `request` defaults to the cached `instruction.md`; `check` defaults to running the
// cached verifier (`tests/test_outputs.py`) — the task overrides either when its criterion
// differs. `files` are the environment's own files (a Docker `COPY`), `setup` are the
// commands a Dockerfile/setup.sh would run before the agent.

export interface SandboxTask {
  id: string;
  request?: string;
  files?: Record<string, string>;
  setup?: string[];
  check?: string;
  mountPoint?: string;
  // When set, run in the task's Docker image (`docker.ts`) — the image already carries the
  // environment, so no host install is needed. `workdir` is the task WORKDIR inside it.
  image?: string;
  workdir?: string;
  // Where the verifier runs. "task" (default) runs it in the task image; "host" runs it via
  // bwrap with the host tools (`container.ts`) — for an image that lacks the verifier's
  // runtime (e.g. `git-leak-recovery` has git but no Python), when the host has it.
  checkIn?: "task" | "host";
  // The turn budget for a live run (default 24). A build-heavy task needs more: the
  // criterion triggers a full rebuild and each background poll costs a turn (`fix-ocaml-gc`
  // sets 60, like the Harbor acceptance). An explicit `--turns` overrides it.
  maxTurns?: number;
  // A command run in the task container before the verifier (e.g. `fix-ocaml-gc` rebuilds
  // the compiler and regenerates tests.txt, which the verifier then reads).
  checkSetup?: string;
  // Docker network mode for the task container. Default "none" (offline); a task whose work
  // genuinely needs the network (crack-7z-hash installs p7zip) sets "bridge".
  network?: string;
}

// `~/.cache/harbor/tasks/<hash>/<id>/` — the Harbor task cache layout.
export function harborTaskDir(id: string): string {
  const root = join(homedir(), ".cache", "harbor", "tasks");
  if (!existsSync(root)) throw new Error(`Harbor task cache not found: ${root}`);
  for (const hash of readdirSync(root)) {
    const dir = join(root, hash, id);
    if (existsSync(dir)) return dir;
  }
  throw new Error(`Harbor task not cached: ${id}`);
}

// The verifier's default entry point: the cached `test_outputs.py` under the task's
// `tests/`. The harness copies the whole `tests/` dir to `<root>/.skein/tests/` and writes
// this runner next to it.
export const DEFAULT_TASK_CHECK = "PYTHONDONTWRITEBYTECODE=1 python3 /app/.skein/tests/run.py /app/.skein/tests/test_outputs.py";

// Runs the task's own `solution/solve.sh` inside the container, for the offline harness
// check (`stageSolution`). The staged apt shim makes the solution's `apt-get` a no-op — the
// tool it installs is already in the image — so the solution replays offline.
export const SOLUTION_COMMAND = "PATH=/app/.skein/bin:$PATH bash /app/.skein/solve.sh";

// A no-op `apt-get` so a solution that begins with `apt-get update && apt-get install …`
// does not fail under `set -e` when the network is off (the package is already present).
export const APT_SHIM = "#!/bin/sh\nexit 0\n";

// A minimal `pytest` stand-in, staged next to `run.py` so a `test_outputs.py` that does
// `import pytest` works without the dependency (the image often lacks it and the network is
// off). Only the surface a verifier uses: `fail`/`skip`/`raises`/`mark`/`fixture`/`main`.
export const PYTEST_SHIM = `"""Sandbox pytest stand-in (see tests/sandbox/task.ts)."""
import contextlib
import re


class Failed(AssertionError):
    pass


class Skipped(Exception):
    pass


def fail(msg=""):
    raise Failed(msg)


def skip(msg="", allow_module_level=False):
    raise Skipped(msg)


def xfail(reason=""):
    raise Skipped(reason)


@contextlib.contextmanager
def raises(expected, match=None):
    try:
        yield
    except expected as exc:
        if match is not None and not re.search(match, str(exc)):
            raise AssertionError("pattern %r not found in %r" % (match, str(exc)))
        return
    raise AssertionError("DID NOT RAISE %s" % (expected,))


def warns(*args, **kwargs):
    return contextlib.nullcontext()


def deprecated_call(*args, **kwargs):
    return contextlib.nullcontext()


class _Mark:
    def __getattr__(self, name):
        def deco(*args, **kwargs):
            if len(args) == 1 and callable(args[0]) and not kwargs:
                return args[0]

            def wrap(fn):
                return fn

            return wrap

        return deco


mark = _Mark()


def fixture(*args, **kwargs):
    if len(args) == 1 and callable(args[0]):
        return args[0]

    def wrap(fn):
        return fn

    return wrap


def param(*values, **kwargs):
    return values[0] if len(values) == 1 else list(values)


def approx(value, rel=None, abs=None, **kwargs):
    return value


def main(*args, **kwargs):
    return 0
`;

// Runs a terminal-bench `test_outputs.py` without pytest or network: import the module and
// call every `test_*` function, exiting non-zero on the first failure. pytest only adds
// reporting here; the assertions are the task's own. A skipped test is not a failure.
export const VERIFIER_RUNNER = `import importlib.util
import sys
import traceback

spec = importlib.util.spec_from_file_location("verifier", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

failed = 0
for name in sorted(dir(module)):
    if not name.startswith("test_"):
        continue
    fn = getattr(module, name)
    if not callable(fn):
        continue
    try:
        fn()
        print(f"PASS {name}")
    except Exception as exc:
        if type(exc).__name__ == "Skipped":
            print(f"SKIP {name}")
            continue
        failed += 1
        print(f"FAIL {name}")
        traceback.print_exc()

sys.exit(1 if failed else 0)
`;
