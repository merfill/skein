# Skein — context design (folded)

> Russian mirror — `docs/context_design_ru.md`.

> **Folded into `docs/ir_semantics.md` §7 and `docs/projection.md`.** This document described
> the projection as working memory with a plan, an `alternatives` container, a `calls` index
> and a bounded `shown` working set. The revision replaced all of that: the context is a
> plain **message tape** rebuilt from the tree, with no separate blocks. The content here is
> kept only as a pointer; do not treat it as current.

What changed:

- the **plan** is a `plan` node over `item`s, each holding alternatives (`alts`); a goal's
  closure is a relation on the goal, not a plan item;
- the **`alternatives` container** is gone — an item is the container;
- the **`calls` index** and the **`shown` working set** are gone — the history (the tape) is
  the memory, and a result body is addressed by `id` with `recall`/`search`;
- the **non-monotone cut** happens only at a goal's closure (its internal messages leave the
  tape).

See `docs/ir_semantics.md` §7 and `docs/projection.md`.
