# Skein — traversal stack specification (folded)

> Russian mirror — `docs/plans/traversal_stack_spec_ru.md`.

> **Folded into `docs/ir_semantics.md` §2.** The traversal model is unchanged in spirit — a
> stack from the root to the current goal, a cursor over the plan, one set of admissible
> moves feeding both the projection and `classify` — but the containers changed: a plan holds
> `item`s, each item holds `alts` (actions or sub-goals). This document is kept only as a
> pointer.

The model, briefly:

- **frames.** The stack `S = [R, G₀ … G_k]` is the path from the root request to the current
  goal; the current goal `G_k` is where the doxa works. Neither the stack nor the cursor is
  stored: the stack is a fold of the focus events (`descend`/`return`), the cursor is
  computed from the plan.
- **spine and arm.** The spine is the stack; the arm is the focus goal's ordered neighbours
  (its plan's items, and an item's alternatives). The engine hands the doxa the whole arm;
  the cursor marks the current node.
- **containers.** A `plan` node holds `item`s (`items`); an `item` node holds alternatives
  (`alts`) that are `action`s or sub-`goal`s; the last child is current.
- **movement.** `advance` (an executed action moves the cursor), `descend` (into the
  request's goal or a sub-goal alternative), `return` (out of a finished goal — a closed
  ancestor trims the branch, not only a closed top).
- **admissible moves** at a point (a fresh request → `create_goal`/`decline`; an open goal →
  `apply`/`create_goal`/`stop`) are computed once and feed both the projection and the gate.

See `docs/ir_semantics.md` §2.
