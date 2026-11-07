# Skein — work states: goals and acceptance criteria

> Draft. It describes the subject, goal and criterion of each state so that they do not blur
> into one another. Implemented in `src/ir/islands.ts`; the general wordings live there, the
> refinements — in the request and transition prompts (`src/loop/prompt/blocks.ts`).
>
> `recovery` was merged into `research` (2026-11-03), `localization` into `patch` (2026-11-04),
> and `orientation` was removed (2026-11-06). The live `ISLAND_IDS` are five: `research`,
> `patch`, `construction`, `verification`, `end`.
>
> See also: `docs/en/system_prompt.md` (why the prompt is a space of states), `docs/en/ir.md`
> (§4.1 — a state is its goal), `tests/sandbox/specs/fix-ocaml-gc.ts` (a reduced task model).

> Russian mirror — `docs/ru/states.md`.

## 1. The notion of a state

A work state is a state of knowledge, not a step or a command. The model is in a state when its
condition holds; it closes the state itself, with its `stop`.

A state has three things:

1. **Subject** — what the state works on: an artifact, a situation, a change, a check.
2. **Goal** — what knowledge must be acquired.
3. **Criterion** — the observable condition that shows the goal is reached and the state may be
   closed.

Rules for the goal and the criterion:

- **`done` is a statement, not an order.** "The file and lines are named", not "find the file":
  the criterion describes a state of knowledge. `what` is the opposite — the state's goal.
- **Checkability.** The criterion must be established from the tape or the working tree. What
  cannot be checked is a slogan, not a criterion.
- **Evidence comes from the tree.** The request is a hypothesis the state must check, not a
  source of facts; what it says may be stale or wrong.
- **The concrete is a result.** Which file, line or command — is obtained inside the state and
  appears in its result, not specified in advance.
- **The request's assumptions are not the criterion.** The area, subsystem and files named in
  the request are hypotheses about the subject ("probably, but not a fact"); they are checked
  against the tree and become neither the goal nor the criterion.

### 1.1 Two kinds of result: artifact and situation

The main axis is **what the state's result is**:

- **Artifact** — a concrete thing one can point to: a file, several files, a record, an image,
  a function, a commit. The result is a pointer to it with coordinates.
- **Situation** — a state of affairs without a single target artifact: deleted/encoded data,
  legacy behaviour, a specification, history. The result is a **description of the situation and
  a method**, not a pointer.

States by the kind of result:

- **Patch** — find the artifact with the defect (together with the cause/violated invariant) and
  make the change it needs: knowledge and action are one cycle, not two states.
- **Research** — describe the situation and establish the method: derive the required result
  from the material or the specification and, if needed, write the output; source checks on a
  copy are allowed.
- **Construction** — create a new artifact/program from the specification or the source's
  behaviour.

`Patch` remains a change to an **existing artifact**. It does not work on a situation.

### 1.2 Acceptance

Acceptance is what shows the task is solved. It is of two kinds:

- **operational** — a command/test/build of the project (`pytest`, `make`, `valgrind`);
- **declarative** — declared conditions: path, format, exact value, provenance, behaviour.

For `Patch` acceptance is usually external (project tests/build), so it is followed by
**Verification**. For `Research` and `Construction` acceptance is the same source check the
state already uses, so the check is **part of the state's criterion**: it goes to `End` on
success and back to `Research`/`Construction` on a bad method.

**Source check** (the code criterion is `matches what the material contains`) — compare the
result with what the material contains: checksum, hash, container metadata, structural
invariant or known records. It is **not** a declared form and **not** "the candidate is
literally in the bytes". The concrete check is named and applied by `Research`.

An external verifier (Harbor/harness) is the final judge, but it is **not a Skein state** and is
usually invisible to the model. Inside a state the model does the strongest available check and
honestly names its limits.

## 2. The concrete states

> **Brief.** Each working state gets the coordinates (`Workspace root`, `Workspace repository`,
> `Working directory` when the shell starts outside the root) and its own environment set;
> closed states and the request turn do not carry these blocks.

### 2.1 Research

- **Input:** coordinates (`Workspace root`, `Workspace repository`) + environment (network/interpreters/package managers).
- **Subject:** a situation whose result is derived from the material or the specification.
- **Goal:** solve the task — derive the required result and, if the task requires it, create the
  output; for building a new artifact from a spec there is Construction.
- **`what`:** `solve a situation: derive the required result from the material or the specification`
- **`done`:** `the task's required result exists in its declared form, is derived from the material
  or the specification, and matches what the material or the request contains`
- **Method:** **source check** — compare with what the material contains (checksum/hash,
  header/metadata, known record, integrity check). A read-only check on a copy is allowed and
  preferred to a guess. Writing the output and working copies is allowed; the material stays
  read-only.
- **Boundaries:** it does not look for a code defect (Patch), nor build a new artifact from a
  spec (Construction). The state is not a gate: if the task turns out to be a build task, the
  model may finish the result here (Research has `write`) or move on; if it is a code defect, it
  goes to Patch.
- **Transition:**
  - → **End** when the required result exists in its declared form and matches the material or
    the request;
  - → **Patch** when the work is a code defect, not yet found or not yet fixed.
- **Example (password-recovery):** the file is deleted; in a 4 MiB image a fragmented ZIP: local
  header at ~1 MiB, data tail at ~3 MiB; the candidate is checked by CRC32; the password is 23
  characters, `8XD…W54`, uppercase/digits.
- **Example (db-wal-recovery):** the WAL is XORed with `0x42`; after decoding — a valid WAL with
  4 frames; the check is SQLite `integrity_check` and specific records.
- **Example (crack-7z-hash):** 7z; the hash via `7z2john`; `john` with a wordlist; the check is
  unpacking the archive.

### 2.2 Patch

- **Input:** `Workspace` — the material map (root/repo/entries/paths) + environment
  (vcs/build/compilers/interpreters).
- **Subject:** an existing artifact with a defect.
- **Goal:** find the defect and make the change it needs — the located artifact and the other
  files the task needs.
- **`what`:** `find the defect in the existing artifact and make the change it needs`
- **`done`:** `the defect is located — the target named with its coordinates, its siblings ruled
  out, and the cause named as a suspicion — and the change is complete: the located artifact and
  every other file the task needs are created or updated, and the result has the declared form`
- **Method — one cycle:** name the target and the cause, make the change the cause entails, read
  the result. A change that does not hold is evidence about the cause: revise the cause and
  change again from it. Do not repeat the same edit and do not bypass an unestablished cause.
- **Boundaries:** the change is not limited to one file: a required file is not postponed to
  Verification. It does not derive a result from the material (Research), nor build a new
  artifact (Construction). It does not fabricate values. Checking and reading a symbol's
  definition is fine; declaring a check as acceptance is not (Verification).
- **Transition:** → **Verification** when the change is complete and the form is checked.
  → **Research** when it turns out the work is a situation, not a defect (correcting a wrong
  start classification). The reverse `V → P` on a failed acceptance: the failure may be in the
  change or in the cause it relied on — both are revisited here.
- **Example (fix-ocaml-gc):** `runtime/shared_heap.c`, `pool_sweep`, ~650; the common advance
  after the free branch uses `Whsize_hd` instead of `wh`; the edit is
  `p += Whsize_hd(hd)` → `p += wh`.
- **Example (fix-code-vulnerability):** `bottle.py`, `_hkey`/`_hval`; CRLF/NUL checks are lost.
- **Example (fix-git):** merge a lost commit into `master`, resolving the conflict.
- **Example (git-leak-recovery):** purge a secret from objects/reflog after Research.

### 2.3 Construction

- **Subject:** a new artifact/program.
- **Goal:** create the artifact from the specification or the material's behaviour.
- **`what`:** `build the new artifact from the specification or the material's behaviour`
- **`done`:** `the artifact exists, is derived from the specification or the material's behaviour,
  and the acceptance check passes`
- **Method:** write the artifact and an acceptance check (test harness, differential run,
  `openssl verify`), run it, and on failure fix it or return to Research.
- **Boundaries:** it does not edit the source artifact (Patch); the material is a specification of
  behaviour, not an object of change; it does not substitute "the file was created" for a check.
- **Transition:**
  - → **End** when the artifact is created and the check passes;
  - → **Research** when the method/spec do not converge;
  - stay/repeat on an execution error.
- **Example (regex-log):** `regex.txt` + a harness on positive/negative lines.
- **Example (cobol-modernization):** `program.py` + a differential run against COBOL.
- **Example (openssl-selfsigned-cert):** key/certificate/PEM + `openssl verify` and field checks.
- **Example (log-summary-date-ranges):** `summary.csv` + an independent recomputation from logs.
- **Example (modernize-scientific-stack):** a new script + a run on sample data.

### 2.4 Verification

- **Subject:** the changed artifact after Patch.
- **Goal:** check it against the task's/project's acceptance.
- **`what`:** `check the changed artifact against the goal's acceptance`
- **`done`:** `the acceptance command passes, or every declared condition holds and the result is
  derived from the source, not synthesized`
- **Boundaries:** it does not write the acceptance or build the check; it runs the ready one
  (project or external). If the acceptance is external/hidden, the model does the strongest
  available check and honestly names the limits. A check that reads only its own output is not
  acceptance.
- **Transition:**
  - → **End** when the result is complete and acceptance holds;
  - → **Patch** when acceptance does not hold: both the change and the cause are revisited in
    Patch.
- **Example (fix-ocaml-gc):** `make -C testsuite one DIR=tests/basic` → 40 passed.
- **Example (fix-code-vulnerability):** `pytest -rA` + `report.jsonl`.
- **Example (custom-memory-heap-crash):** release/debug + valgrind without leaks.

### 2.5 End

- **Subject:** the request.
- **Goal:** finish the work.
- **Criterion:** the request is finished; the check was already made in a closed state — do not
  re-check in End, there are no tools; when the criterion holds — `stop`.
- **Transition:** terminal state.

## 3. Routes

| class | route |
|---|---|
| **Repair** (fix-ocaml-gc, fix-code-vulnerability, custom-memory-heap-crash) | `P → V → End` |
| **Research** (password-recovery, db-wal-recovery, crack-7z-hash) | `R → End` (the result check is in Research's criterion) |
| **Construction** (regex-log, openssl-selfsigned-cert, log-summary, cobol, modernize) | `C → End`; a Construction failure may go to `R` |
| **History** (fix-git) | `P → V → End` |
| **Hybrid** (git-leak-recovery) | `R → P → V → End` (the `R → P` step is an explicit `move`) |

`R` — Research, `P` — Patch, `V` — Verification, `C` — Construction.

The `P ⇄ R` edges are **correctional**, not regular: they are needed when the start
classification `P`/`R` is wrong (Patch learns the work is a situation; Research learns it is a
code defect). The regular routes above do not contain them.

Notes:

- **Patch includes finding the defect**: there is no separate "find the defect" step — the goal,
  coordinates and suspected cause are obtained in the same state where the change is made, so
  the cause is revised by the result rather than passed on unverified.
- **Research needs no separate finding step**: it derives the result from the material and
  writes the output. Route — `R → End`.
- **db-wal**: the WAL is an artifact, but its problem is a situation (encoding/frames); Research
  decodes it and writes `recovered.json`, then `End`. The 2026-11-03 run (K=3, `--turns 24`) —
  3/3, median 24 turns, 0.966₽; the route is not unique: some runs solve it via `P → V`.
- **git-leak**: Research extracts the secret; Patch purges it; Verification checks both. There is
  no `R → P` edge in `next` — the step is an explicit `move`; this is an open question (§7).
- **fix-git**: the lost commit is an artifact; Research finds it and does the merge, and the
  result check is part of its criterion; there is no separate Verification.

## 4. Cycles and errors

- **Research/Construction:** acceptance failed:
  - a method/source-check error → **Research** with the error description;
  - an execution error (path, format, candidate) → stay in the state, fix and repeat;
  - the wrong object/source → **Research** (revisit the material).
- **Patch:** Verification failed: the failure may be in the change or in the cause it relied on
  → **Patch**: revise the cause and change again from it.
- **Wrong start classification (`P` or `R`):**
  - Patch discovered a situation, not a code defect → **Research**;
  - Research discovered a code defect → **Patch**;
  this is a correction of the kind of work, not a regular exit: the condition is "the work
  turned out to be of another kind", not "not sure yet".
- The error travels on the tape in the `Finish` lines of the closed `Patch`/`Verification` (the
  `why` of the failed state); the current implementation does not render a separate `Previous
  failed attempt` block. Several attempts are allowed; there is no gate — the model decides.
- If there is no independent source check, the state does not close "on faith": an honest stop
  stating what was checked and what was not.

## 5. Acceptance instrument

When the task does not ship an acceptance command, `Research`/`Construction` **themselves**
write and run the check as part of their work:

- Research — source-derived: checksum/hash/container metadata/structural invariant/known records;
- Construction — spec/source-derived: a test harness, a differential run, `openssl verify`.

For `Patch` acceptance is a separate project procedure (build/tests), so it is followed by
`Verification`.

The check instrument **is not a new state** and is not a source of truth: its author is the
doxa, the source check comes from source/spec, the external verifier is final. The script must be
independent of the output, read the source and the deliverable, and have a negative control. If
there is no such source check, the check is not invented.

## 6. Why this way

- **The "find" / "change" split was overrated.** A separate defect-finding step could not revise
  the cause by the edit's result, and Patch re-derived the cause. So finding and changing are one
  cycle, Patch.
- **The model notices the mismatch itself.** In the regex run: "there is no code; the task is
  just to write the regex. The state goals are generic". In openssl Patch: "No defect exists;
  the deliverables are new files". These are exactly the situations that need
  Research/Construction.
- **Manual enumeration does not scale.** In password, Skein manually assembled the first
  fragment pair and wrote it; there was no CRC check. If the pair were wrong, there would be no
  enumeration mechanism. Research with a script enumerates candidates, checks them with the
  source check and returns a compact result; thousands of pairs do not enter the context.
- **Fake pass is a real risk.** db-wal synthesized values; log-summary declared the artifact
  ready without an observation; fix-code got a false pass with a missing `report.jsonl`. So
  acceptance must be explicit: for Research/Construction — in the state's criterion, for Patch —
  in Verification. "The script ran / the files were written" is not acceptance.

## 7. Open questions

1. **Implementation:** `recovery` merged into `research` (2026-11-03), `localization` into
   `patch` (2026-11-04), `orientation` removed (2026-11-06); the live `ISLAND_IDS` are five
   states. The transition prompt is rendered from `next[].when`, without `island.what`
   descriptions.
2. **Construction/Research boundary:** log-summary is Construction (visible data), db-wal is
   Research (hidden). Check on live runs whether they mix.
3. **fix-git:** is Research needed for the merge/conflict, or is Patch enough?
4. **Can Verification be folded into Patch** when the project already ships tests? Not yet: it is
   a separate procedure; the question is open.
5. **Script enumeration:** extract the common template (enumeration + source check + compact
   output + negative control) into a Research/Construction hint, not into engine code.
6. **External verifier:** stays outside the states; without an independent check — an honest
   stop.
7. **Validation:** 2026-11-03, K=3, `--turns 24`, net on — `password-recovery` 3/3, 17 turns,
   0.799₽; `fix-code-vulnerability` 3/3, 23, 0.734₽; `db-wal-recovery` 3/3, 24, 0.966₽.
   `crack`, `git-leak`, regex, cobol — ahead.
8. **The full catalogue of 13 tasks and the opencode/Skein trajectories** — separate material;
   only conclusions here.
