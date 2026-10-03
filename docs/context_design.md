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

1. **Decomposition is mandatory.** A non-trivial task is decomposed into
   **stage sub-goals**, each with a concrete, checkable `done_when`. Horizon 2–4,
   grown as we work; no long plans.
2. **An item is a sub-goal (`goal`)**, closed by predicate (`complete`/`check`). An
   `action` item is only for a command you run **right now, verbatim**. For a bugfix
   the stages are `reproduce → locate → fix → verify` (epistemic ones close with
   `complete`, objective ones with a `check`).
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
| 9 | **Does not retain a working set of code** | — | **open** |
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

## 8. Evidence and the working set: hypothesis + `need`

**Problem #9.** The projection shows only the **latest** result. For one decision a
coder needs **several** facts together (build output **and** a code window). Hence the
model oscillates `read ↔ run`: each call evicts the previous one, and they never meet in
one context.

**The fix — the doxa decides, the logos stores and serves.**

1. **Results have addresses.** Each result has an `id`; `calls` shows the `id` (the id
   of the latest occurrence). The model references results by id.
2. **A hypothesis carries what to show.** The proposal gains an optional `need: [id …]`
   — which results to show **in full** on the **next** turn. It applies for **one
   turn**: with each hypothesis the model sets the content anew.
3. **Storing the bodies.** The logos stores a result's body: **a small one directly in
   the node's payload**; **a large one in a temp file**, with a reference (`outputRef`)
   in the node. The projection assembles the requested results (from the payload or, for
   a reference, at the loop level — `project` stays pure) and shows them next to
   `lastResult`.
4. **A `need` limit.** A reasonable safety cap (say ≤5), **declared in the
   instructions**: otherwise a model mistake can eat the whole context. This is not a
   "predetermined history" but protection against unbounded growth.
5. **Addressing by `id`** for now; another scheme later if needed.
6. **Append-only.** `need` is part of the hypothesis record; it changes only through a
   new proposal.
7. **Staleness.** Not handled for now. If a result from **before** a mutation is
   recalled, it is shown as-is; versions and new nodes already exist, and the latest
   mutation is considered current. We return to it later.

**Consequence for the "no file content in the IR" invariant.** Small tool results may
now live in a node's payload, large ones behind a temp-file reference. Secrets still do
not enter. The invariant is amended in the semantics.
