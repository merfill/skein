# Skein — context and plan design (the projection as memory)

> Russian mirror — `docs/context_design_ru.md`.

Related: `docs/projection.md` (the projection's composition), `docs/tools.md` (the tool
contract), `docs/ir_semantics.md` (semantics, §2.6 traversal, §2.8 call summary).

This document answers two questions: **why** we show what we show, and **how** the
model revises a plan. The decisions below are agreed; the code follows as implemented.

## 1. Purpose: the projection is working memory

The projection is **all of the model's memory**. What is not in it, the model does not
know. So the projection has four functions, each covering a class of problems:

1. **Orientation** — where I am and what I want: `path` (the stack to the current node)
   + the goal (`what`/`why`/`done_when`) + a short plan.
2. **Evidence** — what I just learned: `lastResult`, the **full** result of the latest
   call. It is the direct input to the next decision, hence full, not truncated.
3. **Memory and guards** — what I have done, what is forbidden, what is decided:
   `calls` (a signature summary + status, append-only), `constraints`, `alternatives`
   (only when a node is being revised, see §4).
4. **Bookkeeping** — `budget` (turns). Open question (§6).

Principle: show **derived, deduplicated knowledge**, not a raw dump. But the latest
result is shown in full: it is the decision's input. "Memory" — yes, a "turn tape" — no.
The tree is **ReAct unwound along a tree**: traversal is a stack of frames (the spine)
plus per-level siblings (the arms), and the stack is `fold(journal)` over the append-only
IR (`docs/plans/traversal_stack_spec.md`).

## 2. What we show at a given moment

| Layer | What | Why |
|---|---|---|
| Orientation | `path` + the current goal + its plan | know where we are and what is next |
| Evidence | `lastResult` (full) | choose the next operator from the result |
| Memory | `calls` (signature + `ok/fail/refused` + `note`, dedup+count) | do not repeat a done/failed move |
| Guards | `constraints` | do not violate a prohibition |
| Decided | `alternatives` chosen/failed — **only in a revision node** | a new hypothesis from the "did not work" list |
| Bookkeeping | `budget` | (open, §6) |

## 3. The plan: short horizon, append-only, a checklist

**We do not know a plan 10 steps ahead.** A plan is a **notebook**: a commitment to the
near step and a list of intentions that grows as we go, not a forecast. Hence:

1. **A plan is a string sketch plus the first step.** A non-trivial task is given a
   short `plan` — a free-form string, a note to oneself — and a first concrete `step`
   (an action). Only that first step is materialized in the plan container; later steps
   are chosen one at a time as we learn — no long plans.
2. **A plan item is an action** — a command run **right now, verbatim** — executed one
   per turn; the engine never auto-runs the plan. A goal is **not** a plan item: it
   enters only as an **alternative** to a step, when the doxa decomposes that step.
   For a bugfix, `fix` IS the hypothesis: `why` + an `objective done_when` = the command
   that shows the failure, so its own `check` settles it — there is no separate
   `verify`.
3. **A hypothesis is a node, not a thought.** An explanatory guess becomes a goal with
   `why`, and a `check` settles it — not the reasoning text.
4. **Branching on any item.** An item that did not work gets an **alternative**; the
   old one stays as "did not work" (append-only, §5).
5. **The plan is a checklist, not a rigid cursor.** An item may be taken in any order;
   an item is resolved if it is `achieved`/`refuted`/`abandoned` or has a **chosen
   resolved alternative**. Resolved items do not block. This removes the trap where a
   stale item ("`cat HACKING.adoc`", never actually run) holds the cursor and the model
   repeats forever.
6. **Rollback / revision = an alternative at a higher level.** Returned (`return`) to
   the parent/request and proposed a new interpretation — the old branch is kept as
   failed. The same mechanism as an item alternative.

## 4. Alternatives: one mechanism for everything

`alternatives` is the way to "revise" without edits: approaches to a node. Currently
attached to `request`/`goal`; we extend it to **any plan item** (including an action).
The chosen one is the target of the latest `chosen` edge; the rest are derived
`abandoned`.

- **The logos branches, not the doxa.** When the model executes an action **different**
  from the current unfulfilled item, the engine itself adds that action as an
  **alternative** to the item (the previous attempt → `abandoned`); the item is
  resolved once the chosen alternative is executed. The doxa only proposes hypotheses —
  it needs no new discipline.
- **Alternatives are shown only during revision.** The path shows the chosen
  interpretation; the list of options is shown only when the current node is refuted and
  `revises` is needed. Otherwise we risk showing the whole tree.
- **A failure is a record, not a deletion.** A failed option stays `refuted`/`abandoned`
  and serves as the "did not work" list for the next hypothesis or an honest "I don't
  know".
- **The "I don't know" region.** If there are no options left, the node stays
  `refuted`; the model returns upward and takes a new interpretation rather than
  presenting a guess as knowledge.

## 5. Append-only (we do not change — we only add)

In the IR nothing is edited or deleted: any revision is the **addition** of an
alternative/branch. The failed stays. This yields the "did not work" list and allows a
rollback without losing history.

## 6. Problems → what we show

| # | Problem | What covers it | Status |
|---|---|---|---|
| 1 | Does not know where it is and why | `path` + the goal (`what/why/done_when`) | present |
| 2 | Does not know what is next | a short plan (checklist) | plan — to finish |
| 3 | Loses what it just learned | `lastResult` full | present |
| 4 | Repeats what was done | `calls`: signatures + `count` | present |
| 5 | Repeats a failure/refusal | `calls`: `status fail/refused` + `note`; cleared by mutation | present |
| 6 | Does not know prohibitions | `constraints` | present |
| 7 | Forgets the chosen/failed option | `alternatives` in a revision node | present (extend to items) |
| 8 | Does not know the turn budget | `budget` | open (§7) |
| 9 | **Does not retain a working set of code** | `shown` with TTL + cap (§8) | **decided §8** |
| 10 | **Stuck on a stale plan item** | checklist + alternatives | **to fix via §3–4** |
| 11 | Builds a long brittle plan | horizon 1–3, instruction | **to fix** |
| 12 | Context explodes (witness/dumps) | do not inline raw payloads | present |
| 13 | A tool lies (silently cuts) | declared limits + report | present |
| 14 | Search is blind (`.c`) | search by content | present |
| 15 | Cannot see the error cause | `lastResult` full | present |
| 16 | `calls` grows | dedup/cap | later |
| 17 | Cannot "tick" an item done differently | plan-as-checklist + alternatives | fix with §3–4 |
| 18 | Confuses branch context | scope `calls`/`lastResult` by `path` | present |

## 7. Open questions

- **A working set of code (#9).** Decided — see §8.
- **Turn budget (#8).** Whether the model needs the remainder, or a stall signal is
  more useful, is undecided; not doing it for now.
- **`calls` (#16).** How to bound growth without losing the "did not work".
- **The form of an item's alternative.** Whether an action item needs a criterion
  ("grep found N") to be "resolved" is a detail of §3–4.

## 8. Evidence and the working set

**Problem #9.** The projection shows only the **latest** result. For one decision a
coder needs **several** facts together (build output **and** a code window). Hence the
model oscillates `read ↔ run`: each call evicts the previous one, and they never meet in
one context.

**The fix — the logos owns the working set; doxa only retrieves.**

1. **Results have addresses.** Each result has an `id`; `calls` shows the `id` (the id
   of the latest occurrence). The model references results by id.
2. **Level retention.** Everything the **current** branch's actions produced (the plan
   attempts of every level on the path: code windows, build output, checks) is shown in
   `shown` **in full, with no TTL**, until the parent closes; on ascending, the level
   collapses into the `calls` notes. This removes `read ↔ run` oscillation: the current
   attempt's evidence stays in view — the engine, not the model, decides.
3. **A single retrieval entrance — `query {id}`.** There is **no** model-side working-set
   declaration: the model no longer names what to keep. When it needs a body from an
   **earlier** level (or one evicted by the caps), it calls `query {id}`, which returns
   the body and holds it in `shown` for `HELD_TURNS` turns. (`need` was removed: letting
   doxa shape the context contradicts "doxa proposes, logos decides", and a bad id
   refused the whole proposal.)
4. **Storing the bodies.** The logos stores a result's body: **a small one directly in
   the node's payload**; **a large one in a temp file**, with a reference
   (`outputRef`/`errorRef`) in the node. For a run/check, stdout (`output`) and stderr
   (`error`) are stored as separate streams (never concatenated). The projection
   assembles the level results and the queried bodies (from the payload or, for a
   reference, at the loop level — `project` stays pure) and shows them next to
   `lastResult`.
5. **Caps.** The shared `shown` budget is at most `MAX_HELD` (5) bodies and
   `2 × OUTPUT_LIMIT` (16000) characters; explicitly queried bodies come first, the
   current levels fill the rest by recency. The TTL (`HELD_TURNS`, 6) and caps are
   exercised in `tests/workingset.test.ts`.
6. **Addressing by `id`** for now; another scheme later if needed.
7. **Staleness.** `shown` carries only current content: if the file a read was taken
   from has changed since (a different version), the entry is dropped from the working
   set, so the "a `stale` fact is never shown as active content" invariant holds.
   `run`/`check` bodies are historical and never go stale.

**Consequence for the "no file content in the IR" invariant.** Small tool results may
now live in a node's payload, large ones behind a temp-file reference. Secrets still do
not enter. The invariant is amended in the semantics.

## 9. Branch history as an index (retrieval, not repetition)

`calls` is not just "what I did" — it is the **index of the current interpretation's
history**. Each entry has an `id`; a result body is fetched by `id`
(`query { id, start?, end? }`), not by re-running the command. The point is to keep the
context light: the projection carries signatures + addresses, bodies are pulled on
demand.

The index's scope is the **whole subtree of the current chosen interpretation**, not
just the current path: evidence from `reproduce` stays addressable on `locate`/`fix`.
Entries of abandoned interpretations are not shown.

Consequences:

- a repeated `read`/`grep` with the same signature and an unchanged world is a
  **protocol violation**: refused, and the reason names the existing result's `id`
  (semantics §2.7, §4.2);
- a `query {id}` **enters the same working set** (§8): the body is shown from `shown`
  for several turns, so a repeated `query` of that id — while it is in the set — is
  redundant and refused. A body evicted by the cap can be re-queried. For **non-results**
  (`action`/`goal`) a separate set of recently queried ids with the same TTL is kept, so
  a repeated `query` of such a node is refused too. A state query
  (`kind`/`predicate`/`edgesOf`) is not pinned;
- the instructions must say this explicitly: to re-see a step, call `query` by `id`; do
  not repeat the call. This is part of the contract, not a hint;
- `query {id}` is the single retrieval entrance to the working set: a body is shown from
  `shown` for several turns, and a repeated `query` while it is in the set is redundant.
