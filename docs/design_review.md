# Skein — triage of the design critique

> Russian mirror — `docs/design_review_ru.md`.

Status: working note. Source: an external model's critique of
`docs/ir.md` / `docs/concepts.md`, reviewed against the code after commit
`4bb8a32` (verified frontier, structured query, output spill).

This document records, point by point, which of the critique's risks and
recommendations we **accept**, **reframe**, or **reject**, and why. It is not a
plan; it is the reasoning to revisit later.

Legend: **Applied** (already in code), **Accepted** (valid, still open),
**Reframed** (valid concern, wrong fix), **Rejected** (conflicts with design).

## Summary

| # | Point | Verdict |
|---|---|---|
| R1 | Index blow-up | Accepted (open) |
| R2 | "Contents not in the IR" vs memory | Partly applied (command output) / reframed |
| R3 | Transitive staleness and stale checks | Accepted; hole (a) fixed, (b) open |
| R4 | Goal-closure paradox | Rejected as framed |
| C1 | `record_check` tyranny for non-code | Reframed (open) |
| C2 | Graph or tree | Observation accepted; "simplify" rejected |
| C3 | No explicit `set_status` | Rejected (by design) |
| P1 | Context compaction | Reframed; partly applied |
| P2 | `read_artifact(id)` | Rejected (redundant) |
| P3 | provenance split / record rejections | Split verdict; rejections applied |
| P4 | Budget in `Context` | Accepted (open) |

## Risks

### R1. Index blow-up

- **Proposal:** paginate `index`, hide it behind `query`, or aggregate it.
- **Verdict:** Accepted; the tool half is already partly there.
- **Why:** `project` still emits every node (`src/ir/project.ts:122`). The new
  `query` (`id`/`kind`/`status`/`edgesOf`/`verdictOf`, `QUERY_LIMIT = 50`) gives
  a bounded way to ask for what exists, so the pressure is lower — but `index`
  itself remains unbounded.
- **Action:** in Tier 1, bound or aggregate `index` (e.g. only frontier +
  constraints by default, the rest via `query`). Not done now.

### R2. "Contents not in the IR" vs memory

- **Proposal:** lazy `recall(id)` / `read_artifact(id)`.
- **Verdict:** Partly applied, else reframed. The specific tool is redundant.
- **Why:** for **command output** this is now solved (Part D2): long output is
  spilled to `.skein/logs/` and referenced by `outputRef`, retrieved through a
  windowed `read`. For **file contents**, `read(path)` already re-reads on
  demand, so a separate recall tool adds nothing. The real cost is event noise
  and extra turns, not lost data.
- **Action:** none now. If it bites, extend the spill-and-pointer pattern, or
  make a pure re-read not emit new nodes.

### R3. Transitive staleness and stale checks

- **Proposal:** a file-dependency graph, or "any change stales related modules".
- **Verdict:** Accepted; open, Tier 1. The point has two parts of unequal urgency:
  (a) a hole in the staleness rule itself — urgent; (b) transitivity across
  modules — design separately.
- **Why:** see below.

**What "staleness" is and why it exists.** The event journal only grows: nothing
can be deleted or rewritten, or there is neither history nor reproducibility.
But knowledge about code is mutable: a file is edited, and an old fact about it
no longer matches the current contents. The fact cannot be deleted, yet showing
it as current would be a lie. So the fact stays in the journal but is marked
**stale**: "this was true for that file version; the file has changed since".
A *version* is a fingerprint of a file's contents; equal files yield one
version. Thus the journal stays fixed while code knowledge honestly loses force —
the bridge between "the journal only grows" and "code changes".

**Where the hole is.** Today only facts recorded by **reading** a file go stale:
only they carry a version (`src/ir/graph.ts:89`). A **check** record (e.g. "the
tests passed") has no version, so the file-change event never notices it, and a
verified claim stays verified though the code beneath it has changed. The review
records this as a soundness hole: `mutate` **never** invalidates
`verifies`/`check`.

**Illustration** (fixture `off-by-one`):

| Turn | Action | What happens |
|---|---|---|
| 1 | read `src/sum.mjs` | the fact is bound to version `v1` |
| 2 | track "loop stops one short" | the claim is open |
| 3 | fix the loop (`i < n` → `i <= n`) | file is now `v2`; the read fact is marked stale — correct |
| 4 | run `node --test`, tests pass | the claim becomes verified; but it is not recorded against which version |
| 5 | edit the file again | file is now `v3`; the claim is **still shown as verified** |

At turn 5 the tests ran against `v2` while the code is `v3`. If the edit broke
the behaviour, the agent is deceived: the context says "settled".

- **Action:** hole (a) is closed (`docs/plans/check_soundness_plan.md`): a check
  carries a witness; `mutate` stales the `verifies` edge; the projection shows a
  claim as verified only with a live check and lists the rest under `invalidated`.
  Transitivity (b) — a separate design.

### R4. Goal-closure paradox

- **Proposal:** inject `goal_achieved: true` into `Context`.
- **Verdict:** Rejected as framed; the concern is largely mitigated.
- **Why:** closing the goal is **external by design** — the engine must not
  decide `achieved` (doxa/logos; `tests/gate.test.ts`). The loop stops on
  `finish` or the turn budget (`src/loop/graph.ts`), and the system prompt tells
  the model to call `finish`. Part A now also exposes `frontier.verified`, an
  explicit "settled" signal. An engine-set `goal_achieved` would move logos into
  the engine prematurely.
- **Action:** none; optionally make the docs clearer that stopping is not driven
  by the goal's status.

## Conceptual

### C1. `record_check` tyranny for non-code work

- **Proposal:** human arbiter or an LLM critic that issues `record_check`.
- **Verdict:** Reframed; open.
- **Why:** the model already names a **subjective arbiter** (user acceptance)
  beside the objective toolchain (`docs/concepts.md`). So "there is no arbiter"
  is wrong; what is missing is a Tier 0 mechanism for user approval. An LLM
  critic would re-introduce doxa as logos — unacceptable.
- **Action:** Tier 1: a user-approval path that records a check, if needed.

### C2. Graph or tree

- **Proposal:** simplify the model to a tree if the graph is barely used.
- **Verdict:** Observation accepted; "simplify" rejected.
- **Why:** the graph *is* used, and more now: `project` reads `verifies` edges,
  staleness reads `locates` provenance, and `query` exposes `edgesOf` /
  `verdictOf`. Edge kinds are reserved (`src/ir/types.ts`), not dead weight. But
  the doc's claim of path-based relevance is not implemented — that part of the
  observation stands.
- **Action:** none for "simplify"; revisit relevance separately.

### C3. No explicit `set_status`

- **Proposal:** let the agent set a claim to `abandoned`.
- **Verdict:** Rejected by design.
- **Why:** doxa only proposes; logos decides. Agent-side `set_status` would break
  the central invariant `status = open` for proposals.
- **Action:** none.

## Recommendations

### P1. Context compaction

- **Proposal:** a background process / `summarize` event collapsing old
  observations into `summary` nodes.
- **Verdict:** Reframed; partly applied.
- **Why:** an **LLM** summary in the projection is explicitly a listed risk
  (`docs/concepts.md`: the savings vanish). Part D1/D2 is the deterministic
  version for command output: mechanical head+tail excerpt plus a pointer. Any
  compaction must stay deterministic and keep the graph links.
- **Action:** if pursued, aggregate deterministically (e.g. group old
  observations), never LLM-summarize.

### P2. `read_artifact(id)`

- **Verdict:** Rejected (redundant).
- **Why:** `read(path)` already retrieves content; `query` retrieves metadata.
  The valuable pattern is spill-and-pointer (Part D2), not a new tool.

### P3. provenance split / record rejections

- **Proposal:** split `provenance.llm` into `llm_proposal` / `llm_hallucination`;
  record rejected actions as events.
- **Verdict:** Split verdict; the rejection half is applied.
- **Why:** the split is speculative — `provenance.kind = "llm"` is never
  produced in code today (`src/ir/types.ts:34` only declares it). But **recording
  rejections** was a real gap: `classify` rejections went only to the ephemeral
  `recent`, so the model could forget and repeat a forbidden action.
- **Action:** done — a refusal is recorded as a `record_rejection` event with the
  action signature and reason, and shown under `frontier.refusals`
  (`docs/plans/rejection_plan.md`). No node is materialized and the provenance
  split is not done.

### P4. Budget in `Context`

- **Proposal:** show remaining turns/tokens in `header`.
- **Verdict:** Accepted; open.
- **Why:** `maxTurns` lives in the loop, not in `Context` (`src/loop/graph.ts`).
  Turn count is trivial and deterministic; token counts are not.
- **Action:** expose remaining turns in `header`; leave token accounting out.

## What the recent commit changed here

Commit `4bb8a32` moves several points:

- R2: command output now spilled and referenced (D2).
- R4: `frontier.verified` gives an explicit settled signal.
- C2: `query` consumes edges, weakening "the graph is unused".
- R1: `query` provides a bounded inspection path, but `index` is still unbounded.
