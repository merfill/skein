# Skein — tools and the calling contract (proposal)

> Russian mirror — `docs/tools_ru.md`.
>
> **Status: §4 is implemented.** §3 is historical context (the defects are fixed).
> Open questions are in §7, the backlog in §8.

Related: `docs/ir_semantics.md` (operator semantics), `docs/projection.md` (what the
model sees), `docs/testing.md` (runs).

The goal is to pin down an **honest tool contract**: what the model may call, what a
tool undertakes to return, and what instructions to give it. Below: principles, then
the current state (as-built), then the proposed changes.

---

## 1. Principles

1. **A tool honestly does what it declares.** If it declares "read a window of lines",
   the whole window is returned. If there is a limit, it is **declared** in the
   description and in the result ("showing lines X–Y of Z"), not silently cut.
2. **The context is all of the model's memory.** So it must receive:
   - the **full result of the latest call** (within the tool's honestly declared
     limits);
   - a **summary of previous calls without their results** (what was called, its
     status, size).
3. **A failure is a result too.** A failed command, a gate refusal, "no such file" is
   knowledge; it is shown and/or lands in the summary/`negative`, never dropped.
4. **No context budget for now.** We remove `SKEIN_CTX_TOTAL`: first let the tools
   work honestly, measure later. (Separately decide whether an emergency cap is
   needed.)
5. **One operator per turn.** The model proposes exactly one action; the engine
   decides to accept or refuse (see the semantics).

---

## 2. Interface overview

The model proposes an action through **native tool calls** (one flat function tool per
operation, `tool_choice: "required"`); `src/llm/tools.ts` maps the call into the IR
`action`, one of the operators:

| Operator | Purpose |
|---|---|
| `create_goal` | introduce a goal (the request's interpretation — exactly once — or a subgoal) with a plan |
| `apply` | work with the workspace: `read` / `grep` / `list` / `edit` / `write` / `run` / `fetch` / `apply_patch` |
| `stop` | the sole closure: finish the focused goal (no criterion gate) |
| `decline` | decline a non-actionable request: records an `unactionable` node, ends the run |
| `query` | deterministic lookup in the IR tree (does not change state) |

### 2.1 `create_goal { what, why?, sketch, command }`

- `what` — what to achieve; non-empty.
- `why?` — a rationale (text); the hypothesis for a fix.
- `sketch` — a non-empty **string sketch** of the plan (a note to oneself), not a list.
- `command` — the **first plan item**: the concrete command to run now, verbatim; the engine
  runs exactly it **from the workspace root**. A project in a subdirectory takes a
  `cd <dir> &&` prefix (`cd ocaml && make -C testsuite one DIR=tests/basic`); the rule is
  stated in B6 and in the `create_goal` `description`.

Instruction: at a request node it creates the interpretation — **exactly once**: the
request's interpretation is FIXED (a `has_goal` edge), so the `what` must be chosen
deliberately and can never be re-proposed or the request re-interpreted. At an open goal it
decomposes the current plan item into a sub-goal (an alternative to that item). Give a plan
sketch and the first command. `command` is not a special "step" — it is simply the first
plan item.

### 2.2 `apply { action }`

| tool | Fields | Meaning |
|---|---|---|
| `read` | `{ path, start?, end? }` | read a file, or a window of its lines |
| `grep` | `{ pattern, path?, include?, exclude?, before?, after?, from?, count? }` | search the workspace: scope, windows over matches, JSON (see §4.2) |
| `list` | `{ path?, include?, from? }` | list files by mask, JSON (see §4.6); the engine also accepts `exclude`/`limit`, which the model tool does not expose |
| `edit` | `{ path, find, replace }` | exact substring replacement |
| `write` | `{ path, content }` | create a new file or fully overwrite one (overwrite needs a fresh read) |
| `fetch` | `{ url, path? }` | download a URL into the workspace as read-only reference evidence (default `.skein/ref/<hash>-<slug>`) to read and diff (B9); refused on a path outside the workspace / already existing / forbidden / download failure |
| `apply_patch` | `{ patch, strip? }` | apply a unified diff (`patch -p<strip>`, default 1), e.g. an upstream change obtained with `fetch` |
| `run` | `{ command }` | one plain **foreground** shell command: an **observation** carrying `command` and `exitCode` (0 = pass, non-zero = fail, absent on a timeout) plus the output (stdout and stderr separate, §4.3) |

### 2.3 `query { id | kind | edgesOf, start?, end? }`

Deterministic read of the tree/journal: nodes, edges, their payloads; and by `id` — the
**body of a stored result** (a small one from the payload, a large one behind
`outputRef`), optionally a line window (`start`/`end`). Does not change state. The
model-facing tool exposes `{ id, start?, end? }`; the tree selectors (`kind`/`edgesOf`)
remain an engine capability but are not offered to the model.

### 2.4 `stop { why? }`

The doxa's terminal move and the sole closure: it finishes the focused **goal**. The engine
appends a `stop` node as the goal's **last plan item** and records a `has_stopped` edge
goal→stop (the closure and its reason sit in the plan); it then returns to the request and
the run ends. There is **no criterion gate**: `stop` is accepted on an open goal (cycle /
premature-stop detection is deferred). There is **no** `stop` on the request: the
request/run ends when its goal is stopped, never by a `stop` of its own.

### 2.5 `decline { why? }`

Declines to formulate a goal: the request's intent is genuinely not actionable (chit-chat,
no task). It records an `unactionable` node under the request (a `no_goal` edge) and ends
the run. Available only while the request has no interpretation yet (before `create_goal`);
give `why`. Never invent a goal just to close such a request.

---

## 3. Current behavior (as-built) and its defects

| tool | What it declares | What it actually returns | Defect |
|---|---|---|---|
| `read {path,start?,end?}` | a window of lines | the window content → **transient** text, clipped at 8000, then by the projection — **400 chars from the start**; the observation stores only `{ref,version,bytes}` | content is **not stored**; different windows of one file used to count as a repeat (fixed: the range is in the signature) |
| `grep {pattern}` | a search | matches `path:line:text` → transient text, then 400 chars; the observation stores only `{count}` | matches are **not stored**; it used to not see `.c` at all (fixed: text by content) |
| `run {command}` | run a command | output → transient text; the observation stores `{command, target?, exitCode, output}` (up to 8000, head+tail) | the projection still shows 400 chars from the start |
| `edit {path,find,replace}` | replacement | the fact of the edit | — |
| `query {...}` | a tree read | up to 50 rows per selector | cannot reach `read`/`grep` content (it is not there) |

Root defect: **the work result is thrown away, and only a 400-char excerpt is shown.**
The prompt meanwhile advises "read again or query if you need it"
(`src/loop/propose.ts:27`), though re-reading is not allowed and `query` returns no
content. The model asks for 120 lines — it sees ~8.

---

## 4. Proposed changes

### 4.1 `read`: a window with a declared maximum (decided)

- `read { path, start?, end? }`:
  - without `start/end` — from the start of the file;
  - with `start/end` — a window of lines (1-based, `end` inclusive).
- The **window maximum `MAX_READ_LINES = 400`** (decided) is **declared in the tool
  description**: the model knows the limit in advance.
- If more than the maximum is requested, or the file is longer than the window, the
  tool returns the maximum and **explicitly reports**: "showing lines 1–400 of 3000;
  continue from 401".
- The result is shown **fully** (this is `lastResult`, not cut to 400 chars).
- Consequence: the window content lives in `lastResult` for **one turn**; a previous
  read on the current branch is kept in `shown` (and can be pulled back via
  `query {id}`). An **identical** re-read (the same window, with an unchanged world) is
  refused as `repeated_action`; a **different** window is a new read. If the needed part
  is at a window boundary (read 1–100 and 101–200, but the code is at 80–120), read a
  window with margin (say 60–160). A **thrash** is also refused: once an unchanged file has
  been read twice with no edit in between, a further read is `repeated_action` — the body is
  already addressable, so name the cause and edit; an edit resets the count (`OP-AP-READ-6`).

### 4.2 `grep`: scope, windows over matches, JSON (decided)

- `grep { pattern, path?, include?, exclude?, before?, after?, from?, count? }`:
  - `path` — a file or a directory (the workspace root by default); the scope is part
    of the action signature;
  - `include`/`exclude` — glob filters over paths (`**/*.c`, `runtime/**`,
    `**/.depend` as an exclude); choosing "where to search" (code/logs/tests) is the model's job;
    there is no language→extension table in the engine;
  - `before`/`after` — context lines above/below, **`5/5` by default**;
  - `from`/`count` — a window **over matches** (1-based, like lines in `read`);
    `count` defaults to `100`, maximum **`MAX_GREP_MATCHES = 200`**;
- the result is **valid JSON**:
  `{ pattern, scope, context, total, from, returned, next?, results:
  [{ path, line, match, before: [], after: [] }] }`. Matches are structurally
  separated from each other, the matched line (`match`) from the context
  (`before`/`after`); the context of adjacent matches may duplicate;
- byte limit (**`OUTPUT_LIMIT = 8000`**): when exceeded, whole trailing results are
  dropped, `returned` shrinks, `next` points to the continuation; the JSON stays valid
  (the middle is never cut);
- pagination is the same `grep` with a new `from`: recomputation is deterministic (like
  re-reading a window in `read`); the window body is kept via `storeOutput`, so recall
  via `shown`/`query {id}` works exactly as for `read`;
- default skips: `SKIP_DIRS` directories + dot files/directories (`.depend`,
  `.mailmap`); `.gitignore` filtering comes later.

### 4.3 `run`: the full output, stdout and stderr separate (decided)

- Show the command's full output (not 400 chars from the start); when
  **`OUTPUT_LIMIT = 8000`** is exceeded — head+tail with an explicit note +
  `outputRef`/`errorRef`.
- **stdout and stderr are captured separately and never concatenated** (`spawnSync`).
  The result carries `output` (stdout) and `error` (stderr) as distinct fields; `error`
  is always kept on a failure. A command that runs `2>&1`/`&>` merges the streams before
  the engine sees them, so the prompt forbids it: the engine, not the shell, decides
  how the two are shown.
- Store both in the observation (already the case) for `query`: a small body inline, a
  large one behind `outputRef`/`errorRef`, and `query {id}` reads the full body, not the
  inline excerpt.
- A failed `edit` (`find` not found) materializes the file's **current content** in the
  failure observation and keeps it in `shown`, so the model copies `find` verbatim from
  there instead of re-reading a file it already read (which the repeat guard refuses).
- A run that produced **no `exitCode`** (a timeout) is **not** a repeat: the timeout brought
  no knowledge, so the same command may be repeated. Its `exitCode` is ordinary output, not
  a closure oracle — a goal is closed only by `stop`.
- A run killed by a **signal** (a crash, not a controlled exit) carries `signal` (e.g.
  `SIGSEGV`) — never a bare nonzero exit. The wrapper raises `ulimit -c unlimited`, so
  when the platform writes a core the engine finds the newest `core*` in the workspace
  and, if `gdb` is installed, attaches `gdb --batch -c <core> -ex bt -ex "info locals"`
  as `backtrace`. When no core was written, the engine reports the kernel's
  `core_pattern` so the absence is explained, not silently swallowed. `lastResult`
  carries `signal`/`core`/`corePattern`/  `backtrace`, and a `calls` note names the signal.

### 4.4 Projection: latest result + summary (decided)

- `lastResult` — the **full** result of the latest call (§4.1–4.3).
- `calls` — a **summary of previous calls without results**: per entry
  `{ id?, action, status: ok|fail|refused, note, count }`, deduplicated by signature.
  `action` includes the parameters: for `read` — the **range** (`read f [1-100]`),
  for `grep` — the **pattern and context** (`grep sweep 5/5`), for `run` — the
  command, for `edit` — the **short diff** (`-find +replace`). This gives the model
  "memory of what was already done" without inflating the context, and makes coverage
  visible. An edit keeps `find`/`replace` in its action payload, so a failed or repeated
  edit shows the exact `find` already tried instead of a blank "applied".
- `negative` is **merged into `calls`** (one list): status `refused`/`fail` + the rule
  "do not repeat while the world has not changed". A repeated command with the same
  signature (`read`/`grep` too) and an unchanged world is **refused**, and the reason
  names the `id` of the existing result and says how to see it: if the body is already in
  `shown`, use it there; otherwise fetch it via `query {id}` (§4.5). The advice never
  sends the model to `query` a body that is already shown — that is itself refused, and
  the model would loop `read → query → read`.
- `shown` is the **working set**, owned by the engine: the produced results of **every
  level on the current branch** (not just the leaf) are kept, so a stage's evidence (the
  error that motivated the next stage) stays in view until the parent closes, newest
  first. `query {id}` adds one **result body** from an earlier level (or an evicted one),
  held for **`HELD_TURNS` (6)** turns (re-querying refreshes); the cap is `MAX_HELD` (5)
  bodies, the least recently requested evicted first. Each body is bounded per tool by
  `OUTPUT_LIMIT` (8000 characters) — `read` included (whole lines, with a continuation
  hint) — so there is no separate total-character cap: one was removed because it silently
  dropped a body larger than the cap (the source window being edited), trapping the model
  in a `query` loop (docs/benches/bench_report.md §4.4). A read observation whose file has
  changed since is dropped (stale content is
  never shown as active); `run` bodies are historical and never go stale. There is
  **no** model-side declaration of what to show: `query {id}` is the single retrieval
  entrance.
- `SKEIN_CTX_TOTAL` is not applied; `SKEIN_CTX_EXCERPT` is no longer needed.

### 4.5 `query`: fetch a result by `id` (decided)

- `query { id, start?, end? }` returns the **body** of a stored result (a small one
  from the payload, a large one behind `outputRef`), optionally a line window.
- This is the "index" mechanism: a past result is fetched by `id`, not by repeating the
  call. A repeated command with the same inputs and an unchanged world is refused (see
  §4.2, semantics §2.7) and the reason names the `id`.
- `query {id}` **enters the working set** (§4.4): the body is shown from `shown` for
  several turns. Re-querying the same `id` **while it is in the set** is redundant and
  refused; a body evicted by the cap leaves `held`, so re-querying it is **allowed**. For
  **non-results** (`action`/`goal`) a separate set of recently queried ids with the same
  TTL is kept, so a repeated `query` of such a node is refused too (spin). A state query
  (`kind`/`edgesOf`) is not pinned: its answer changes as the graph grows.

### 4.6 `list`: file listing (decided)

- `list { path?, include?, from? }` (the model tool; the engine schema also accepts
  `exclude`/`limit`, not exposed):
  - scope and filters (`path`/`include`) — as for `grep`; the same default
    skips (`SKIP_DIRS` + dot files/directories);
  - `from`/`limit` — a window **over files** (1-based); the engine defaults `limit` to
    `LIST_LIMIT_DEFAULT` (200), capped at `MAX_LIST_FILES` (500);
- the result is JSON: `{ root, total, from, returned, next?, files: [] }`;
- read-only and idempotent (a repeat is not a refusal); it gives the model visibility
  of extensions so it can set `include` for `grep` meaningfully.

### 4.7 `run`: one plain foreground command (decided; reduced)

- A `run` **blocks** until the command exits or the cap (`SKEIN_RUN_TIMEOUT_MS`, default
  120 s) elapses; a timeout yields no `exitCode` (no verdict, just output). A build or a test
  suite is run this way: the turn waits for it, one turn for the whole command.
- The model-facing `run` is `{ command }` only. `target` (a criterion check) and the
  `background`/`job` machinery are **removed from the model path**
  (`docs/plans/goal_reduction_plan.md` §4): there is no criterion to check and no job to
  poll. The `fsWorkspace` job API (`startJob`/`pollJob`, `.skein/jobs/<id>.{out,err,code}`)
  remains an engine/test seam but is not reachable from a proposal.
- stdout and stderr stay in **separate** logs (the §4.3 rule holds). A run is never a
  closure oracle; a goal is closed only by `stop`.

---

## 5. Prompt: instructions and strategy

The prompt currently describes the interface but **sets no strategy** and does not
reflect the real limits. Proposed:

1. **Honest limits** of each tool (from §4) in its description.
2. **An explicit strategy** for bugfix tasks:
   1) **reproduce** the failure (usually via `run` of the verification command or a
      build/test) and get a concrete error;
   2) localize by the error/code;
   3) fix (`edit`);
   4) re-run the same command; close the goal with `stop` once it passes.
3. **The workspace is the source of truth.** Do not assume VCS/history/diff. If `git`
   (or another history tool) is unavailable — **do not hunt for it**, work with files
   and behavior (see §6).
4. **What to do with a failure/refusal**: look at `calls`/`negative`, do not repeat;
   change the approach, not the phrasing of the command. A failure that says the command
   or path is missing (`No such file or directory`, `can't cd`, `No rule to make target`)
   is a wrong working directory, not bad code: apply the spelling with a `cd <dir> &&`
   prefix (the project directory), or a sub-goal whose command carries it, instead of
   repeating the bare command.
5. **How to read code**: `grep` to localize, `read` a window; the whole file when
   needed; do not re-read the same window without a change to the world.
6. **The context holds only the latest result.** Previous results (including read
   windows) are **not** stored — there is only a summary of calls (`calls`). If an
   earlier fragment is needed (including at a window boundary), **re-read the
   window**, with overlap if necessary; do not rely on memory of a previous result.
7. **Where to search.** Pick the scope from the evidence: logic is in the sources
   (`include` by the project's language), a failure/log is in the output and log files.
   Set `path` when a file/directory is named in the error, the first `command` or the
   hypothesis; grep the whole tree only to localize. A `grep` result is windows over
   matches: if there are more matches than the window, continue with `next`/`from`
   **without** changing the `pattern`.

### 5.1 How to determine the goal from the request (and not reach for `git`)

This is a mandatory separate part of the prompt: without it the model applies a coding
agent's default reflex ("look at the diff").

1. `request.text` is **raw motivation**, not a ready-made task. The first move is
   `create_goal`: formulate an interpretation (`what`), a rationale (`why`), a plan
   `sketch` and the first `command`.
2. If the request names a **verification command** — take it verbatim as the first
   `command` — but the engine runs it from the **workspace root**, not a
   project subdirectory. A named command is authoritative; its working directory is
   resolved from the tree. If the project lives in a subdirectory, the literal command
   must carry the `cd <dir> &&` prefix (`cd ocaml && make -C testsuite one DIR=tests/basic`),
   never the bare command. The rule is stated in B6 and echoed in the `create_goal` tool
   `description` (the schema the model sees on every call); the live test
   `tests/live/root-cd.test.ts` guards it with one call per layout.
3. After the goal, the first step is to **reproduce** the failure (run the
   verification/build), not to look for a change history.
4. **The workspace is the source of truth.** Do **not** assume a VCS, `git`, a diff,
   or history. If `git` (or similar) fails — **do not try again**; move on to files
   and reproduction.
5. **Example (matching).** Request: "I broke the GC build (the project is in `ocaml/`),
   the compiler crashes during bootstrap; verify with
   `make -C testsuite one DIR=tests/basic`". Correct:
   - goal: `what: "fix the GC regression so the basic testsuite passes"`,
     `command: "cd ocaml && make -C testsuite one DIR=tests/basic"` (the project is in a
     subdirectory, so the literal command carries the `cd` prefix);
   - a plan of **commands**: `reproduce` and `locate` are plain **actions** (run the command,
     read/grep/diff); `fix` IS the hypothesis — `why` states it — and the goal is closed by
     the doxa's `stop` once the work is done (there is no separate `verify`, no `complete`
     and no criterion check), not a list of bare commands.
6. **Anti-example.** `git diff`, `git log`, hunting for `.git` — a dead end without a
   VCS; do not do it. A `git` failure in `calls` is a signal to change the approach,
   not the command.

Keep the examples in the prompt **short** (one correct move + one anti-example):
the principle "do not assume a VCS" alone is not enough against a strong reflex.

---

## 6. Analysis: where `git` came from

This is not a call to a nonexistent tool — `run` can run `git`. It is an
**unverified assumption** that the environment refutes and the prompt does not
correct.

The chain:

1. The task text: "**I have been making some changes** to the OCaml garbage
   collector… I seem to have broken things". The phrasing "I was making changes"
   makes a human/agent reflex to "look at the uncommitted changes" → `git diff`.
2. Neither the prompt nor the task says whether a VCS exists. The prompt is silent
   about VCS.
3. The task harness **removed `.git`**. `git` fails: `fatal: not a git repository`.
4. The failure lands in `negative`, but the **belief** "there must be a diff
   somewhere" is not refuted — only a specific invocation is. The model tries another
   root/command (`git status`, `git log`, `cd … && git diff`), fails again.
5. The right move is to **reproduce** the crash (`make`), not to look for history.

Conclusion: an **explicit prompt clause** is needed — "do not rely on VCS; if there
is no history, work with files and reproduce the failure" — plus the strategy from
§5.

---

## 7. Open questions

- **Whether to store `read`/`grep` content** in the IR (observation payload) or
  behind a workspace reference; how that squares with the invariant "file content is
  not stored in the IR". With the §4.1–4.4 decisions there is no pressing need.
- **The format of the instructions and strategy** in the prompt (how hard to
  prescribe an order).
- **Whether `edit` by line number/range and other tools** (e.g., `list`) are needed,
  or `run ls` is enough.
- **Bringing the budget back:** when and in what form if the context becomes a problem
  again (not applied for now).

---

## 8. For the future (backlog, not now)

An extension of the tool set, recorded so it is not lost. Ordered by the size of the
capability gap; **not part of the current implementation**.

1. **`write`** — create/overwrite a whole file: `{ path, content }` — **done**
   (`docs/ir_operations.md` §2.2.6): a new file is created; overwriting an existing one
   requires a fresh read; writes a `mutate` with the new version.
2. **`list`** (a.k.a. `glob`) — **done**, see §4.6. Removes parsing of `run ls/find`
   (unstructured, unbounded output) and gives the model visibility of extensions.
3. **`edit` by range / `multiedit`** — editing by line numbers and atomic grouped
   edits: `find/replace` breaks on ambiguous/duplicated fragments.
4. **`fetch`** (URL → workspace as read-only reference) — **done** (Phase 4):
   `{ url, path? }`, default `.skein/ref/<hash>-<slug>`; it enables B9 (obtain a
   reference and diff). **`apply_patch`** (unified diff) — **done** (Phase 4):
   `{ patch, strip? }`.
5. **Later:** `web_fetch`/`websearch` (docs, error analysis) and LSP operations
   `symbol` (definition/references/rename) — heavy, a separate stage.

**Non-goals (deliberately):** VCS (`git`), a `todo` tool (the plan lives in the IR),
browser/screenshots, subagents, MCP — outside the current design.