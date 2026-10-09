# Skein — traversal stack specification (spine and arms)

> English mirror of `docs/plans/traversal_stack_spec_ru.md`.
> Basis — the discussion of alternatives, plan revision and tree traversal.
> Touches `docs/ir.md`, `docs/plans/step_reduction_plan.md`, `src/ir/traversal.ts`,
> `src/ir/project.ts`.
>
> **Superseded in part by `docs/plans/goal_reduction_plan.md`.** The criterion gate
> (§2.3, §9), `done_when`/`chosen`/`state`/`revises` and the `checkReady`/`nextAction`
> projections are removed: a goal is `what`/`why`/`sketch` + a plan seeded by the first
> `command`, closed only by the doxa's `stop`. The spine/arm/cursor/traversal model itself
> still holds.

## 1. Purpose

Fix the traversal model: a **stack of frames** (the spine) and **arms** (the siblings at a
level). This is needed so that:

- the projection is bounded (spine + working bodies, not a growing tape);
- plan revisions (alternatives) reach the context explicitly and are never lost;
- sessions are saved and reproduced deterministically.

## 2. Invariants

1. **The IR grows monotonically.** Engine and doxa only add nodes/edges; nothing is
   deleted or rewritten.
2. **Determinism.** `same events → same Context`: the projection (including the stack) is
   a pure function of the journal.
3. **Closure only by `stop`.** A criterion run's `exitCode` is the only pass/fail fact;
   the model does not declare success.
4. **Stack = fold(journal).** The traversal stack is not independent state but a
   derivation; it must equal a rebuild from the journal.

## 3. Model: frame, spine, arm

**Spine** — the sequence of frames, one per level from the root to the focus:

```
frame = {
  node,            // spine node: request or goal
  arm,             // this level's arm container: the goal's plan or alternatives
  siblings[],      // ordered children of the container (the level's siblings)
  cursor/chosen    // position within the arm (first unfulfilled item / chosen option)
}
```

- **Spine** = the frame stack (depth = path length; small).
- **Arm** = the frame's `siblings`. For the root frame (request) these are the
  interpretations; for a goal frame, the plan items. One mechanism covers both choosing
  a hypothesis and the steps of a plan.
- **Move** = push a new frame (descended into a sibling) or pop (returned).
- **An arm is ReAct in place.** Within one arm the loop is exactly ReAct: a goal is created
  with a plan of one item-command, the item runs on its own turn, the result is journaled
  and fed to the doxa, which adds the next node or stops; a tree appears only where an
  item has alternatives (§6). Every such step is an IR event, which plain ReAct does not
  keep.

The parent arm is the container the node was chosen from: **alternatives** (for an
interpretation/variant) or the **parent's plan** (for a subgoal/item). In the projection,
a choice among alternatives appears as the node's `alternatives`, a choice within a plan
as the parent frame's `plan`. Symmetry: `alternatives` (how we were chosen) + `plan`
(whom we choose).

## 4. Derivation from the journal (rebuild algorithm)

Rebuilding the stack from the journal (this is also session load):

1. Start: stack `[root]`.
2. Replay events in order:
   - `descend node` → push a frame for `node`;
   - `return` → pop.
3. **Normalize the focus to a fixpoint** (deterministic, needs no doxa events):
   - if the top is a request with a chosen, unfinished interpretation — push it;
   - if the top is a goal with a first unfulfilled subgoal — push it;
   - if the top is finished and not the root, or under a finished ancestor — pop.
4. Result — the frame stack; arms are derived from containers (§5).

Maintaining the stack incrementally within a session (push/pop instead of rebuilding each
turn) is allowed as an optimization, but only if the result provably equals the rebuild.

## 5. The arm: containers and cursor

A frame's arm is a container node (`plan` or `alternatives`) with ordered children (order
= insertion order via `item` edges). Containers and edges are the source of truth; there
is no separate storage for the arm.

- **Cursor** = the index of the first unfulfilled plan item. "Fulfilled" honors the
  item's chosen alternative (§6).
- **chosen** (for alternatives) = the last-chosen option (a sequence of `chosen` edges;
  the latest wins).
- **Arm history** — every sibling with its state (`open` / `executed` / `stopped`; the
  criterion facts and supersession are derived reads, not states). Executed siblings are
  never dropped: they stay in the arm.

## 6. Plan revisions (alternatives) — append-only

A "plan revision" is **adding a node**, not editing:

- a new item — a new `item` edge into the plan;
- replacing/bypassing an item — an `alternatives` container is created on the item and
  the new option is placed there as `item` + `chosen`; the original item stays a sibling;
- a new interpretation of a goal whose criterion failed — a sibling in the owner's
  alternatives container (the request or the goal).

The plan sketch given at goal creation is **frozen as nodes**; all later revisions are
additions. Hence the "effective plan" and the "next item" are **derived**: the first
unfulfilled item, honoring the chosen alternative.

A goal's criterion (`done_when`) is **immutable**: if the criterion turned out wrong, that
is a failed criterion — a case for a new variant, not an edit of the goal's body; a new
attempt is a new variant.

## 7. Projection

The projection = the frame stack + history by address:

- for **each** frame, its arm is shown in full: siblings with their `state`, the current
  one marked; plus the node's parent arm (alternatives);
- the **focus** frame — expanded, including the nested alternatives of the current
  sibling (the item's revision history is visible in place);
- **ancestor** frames — compactly (arm + cursor, no result bodies);
- result bodies — only via the working set; everything else — by address `query {id}`.

Shape (sketch):

```
path: [
  { id, kind, state, text|what, why?, done_when?,
    alternatives?: { chosen?, items: [{id,label,state,chosen,why?}] },  // how the node was chosen
    plan?: { cursor?, items: [
       { id, kind, label, state, why?,
         alternatives?: { chosen?, items: [...] }                        // the item's revision history
       } ] } }
]
```

Relation to the current code: `planView`/`alternativesView` (`src/ir/project.ts`) provide
this, including the rendering of alternatives inside plan items (the item's revision
history) — `TR-9`.

## 8. History and addressing

- Result bodies do **not** grow in the context: the working set is bounded
  (`MAX_HELD` / `HELD_CHARS`), and an evicted body is recalled with `query {id}`.
- The `calls` index is a compressed memory of what was already done (status, short note).
- Nothing is deleted: eviction from the working set is not a loss from the IR.

## 9. Verification

- The criterion fact is produced **only by an explicit run targeted at the goal**
  (`run { target }`): an observation with `target` and `exitCode`. Matching a command's
  text is never enough.
- Running a command that equals `done_when` as a **plan step** (reproduce) is an ordinary
  observation, not a criterion (it carries no `target`).
- The engine does **not** auto-run the plan (A4 was retired): each step is executed by the
  doxa on its own turn, one at a time.

## 10. Session

- What is saved is the **event journal** (`events`), not the stack.
- On load, the stack and arms are rebuilt per §4–§5; a stack cache is allowed but must
  match the rebuild.
- Replay (trace) is the same mechanism: journal → stack → projection at each turn.

## 11. Decisions and open questions

**Decided:**

- **Render revisions inline at the item.** An item's alternatives are shown inside the
  `item`, not as a separate `revisions` block: traversal is "walk the plan, descend when
  needed, return and revise when needed", and the revision must be visible where the item
  is.
- **No explicit "insert" node.** Order is given by `item` edges; a revision is a new
  `item` or an alternative to an existing item (§6).

**Open:**

- May doxa **insert** an item into the middle (not only append + alternatives to existing
  items)? Decided during implementation.
- **Eviction priority of ancestor frames' arms** as siblings grow — clarify in process
  (arms are small today; no problem observed).
- The exact parent-arm shape for an inserted item (inheritance of `why`).
