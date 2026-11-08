# Skein — tools and the calling contract

> Russian mirror — `docs/ru/tools.md`.
>
> This is the model-facing contract: what the model can call, what each tool returns, and how
> refusals reach the tape. The IR semantics are in `ir_operations.md`; the state tool surfaces in
> `states.md`; the tape in `projection.md`.

## 1. The model surface

The model replies with native tool calls. The executor maps each call to an IR action; the model
never works with IR node ids directly.

- `move` declares the next state.
- The work tools — `read`, `grep`, `list`, `edit`, `write`, `bash`, `webfetch`, `apply_patch` —
  are IR `apply` actions.
- `recall` and `search` read a stored result by id.
- `decline` rejects a request that has no actionable task.

There is **no `stop` tool**. A state is closed by a plain text reply, which the executor records as
a `stop`. `move` and `decline` are the only structural tools: they change the state machine, not
the workspace.

The tool names, parameters and descriptions ship in the request's `tools` field, generated from
`PROPOSAL_TOOLS` (`src/llm/tools.ts`). They are not repeated in the prompt text.

## 2. Tools

| Tool | Parameters | What it does | Returns |
|---|---|---|---|
| `move` | `{ state, what? }` | declares the next state; `what` is an optional note about the subject | the tape shows `Start state <label>`; the first `apply` seeds the state's turns |
| `read` | `{ filePath, offset?, limit? }` | reads a file or a line window (`offset` is the 1-based first line, `limit` the maximum number of lines) | at most ~32K chars; a larger file reports `[lines X-Y of Z; continue from Y+1]` |
| `grep` | `{ pattern, path?, include?, from? }` | searches file contents by regular expression; `path`/`include` scope the search | line-numbered plain text (`path:line:match`, context `path-line-text`, default 3/3); `from` is the 1-based start, default 50 and max 100 matches |
| `list` | `{ path?, include?, from? }` | lists workspace files; `path`/`include` scope the listing | JSON; 100 files by default, 200 maximum; the window is kept near 8K |
| `edit` | `{ filePath, oldString, newString }` | replaces the first occurrence of `oldString` in an existing file | mutates the file; the tape shows `mutated <path>` |
| `write` | `{ filePath, content }` | creates a new file or fully overwrites an existing one | mutates the file; overwriting needs a fresh read of the file |
| `bash` | `{ command, workdir?, timeout? }` | runs one synchronous command from the workspace root; `workdir` selects a subdirectory; `timeout` is in milliseconds | `exitCode` and output; stdout and stderr are captured separately; the shown output is the tail (~8K), the full stream is stored |
| `webfetch` | `{ url, path? }` | fetches a URL into the workspace, or to the executor-owned ref path when `path` is absent | a read-only file; the IR records `fetch` |
| `apply_patch` | `{ patch, strip? }` | applies a unified diff (`patch -p<strip>`, default 1) | mutates the changed files |
| `recall` | `{ id, start?, end? }` | reads a stored result by id, optionally a line window | the body or window, with a `continue from N` cursor for a longer body |
| `search` | `{ id, pattern, before?, after? }` | searches inside a stored result by id with a regular expression; searches stdout and stderr | matching line windows as plain text, with context (default 3/3) |
| `decline` | `{ why? }` | declines a request whose intent is not actionable | records `unactionable` and ends the run; available only while the request has no state |

`edit` refuses when `oldString` is absent, the file changed since the last read (`stale_base`), a
constraint forbids the path, or the file does not exist. `write` refuses an unseen file or a stale
base. `bash` refuses an identical repeat against an unchanged world; a timeout carries no exit
code. `grep`, `list` and `read` also refuse an identical repeat against an unchanged world. A bare
`recall` of a body already in view is refused; a windowed `recall` is new content. `search` has no
paging: a broad pattern is bounded with a note to narrow it.

## 3. The result contract

Each tool has its own byte budget. The tape shows the tool's window whole and never cuts out its
middle:

- `read` — 32K;
- `grep`, `list`, `bash` — 8K;
- `recall` — 64K.

An inspection result (`read`, `grep`, `list`) is consumed from the beginning, so the head is kept.
A command's output matters at the end, so `bash` keeps the tail. Only a body that still exceeds the
tool's budget is bounded, with a note about the omission.

The executor stores the full body as a file and the action keeps an `outputRef`. Access is by
identifier, not by path: `recall { id, start?, end? }` reads a fragment, `search { id, pattern }`
searches the body. A `recall` or `search` is itself a turn of the open state and elides with the
state on closure.

`edit`, `write` and `apply_patch` mutate files and produce `mutated <path>` on the tape instead of
an observation body. A failed call is never discarded: it is recorded as an observation with a
reason, not dropped.

## 4. Refusals

A **structural** move (`move`, `decline`) is refused by the executor when it is not admissible: no
node is created, and the reason reaches the tape as a one-off `rejected <move>: <reason>` on the
next turn.

A **command** is not refused as a structural move. Its non-execution is recorded as an action and
an observation with a reason: `repeated_action`, `stale_base`, a forbidden path, an empty `bash`, or
a path outside the workspace. A tool failure is a failed observation: a missing file, a bad
`grep`/`list` scope, an absent `oldString`, or a non-zero exit, a timeout or a signal.

The exact reason tokens and their registry ids are in `ir_operations.md` §5.

## 5. Tool surface per state

The executor binds the offered tools from `Context.applicable`, which is derived from
`Island.applies`:

- a fresh request offers `move` and `decline`;
- a transition offers `move`;
- an open state offers the state's apply tools plus `recall` and `search`;
- the terminal state offers none, because the model closes it with text.

The per-state tool sets are listed in `states.md`. `bash` is dual-use, but the state's instruction
still bounds its work: Verification must not change the artifact, and End has no tools.

## 6. Why this shape

- **Honest limits.** Every tool announces its budget and reports a continuation cursor instead of
  silently cutting the result.
- **Addressable results.** A large body stays in the journal and is reached by id, not by copying it
  into the context again.
- **One flat tool per operation.** The model calls the native tool; the executor translates it into
  the IR action. This keeps the model-facing names close to a coding model's priors.
- **No separate stop.** Closure is a text reply, recorded by the executor; there is no tool whose
  only purpose is to close a state.

Non-goals: no background or job tools on the model surface, no tree-selector tools, no
VCS-specific tools, and no hidden context budget that truncates a tool result.
