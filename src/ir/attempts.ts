import type { Event } from "./events";
import { childrenOf, type State } from "./graph";
import { actionsOfMove, asCall, lastFailingRun } from "./project";
import { currentMove, isMoveFinished, moveIsland } from "./traversal";
import type { Action } from "../llm/schemas";
import type { Workspace } from "../tools/workspace";

// The Patch -> Verification pair that failed, and the engine's reversal of the failed Patch.
// The attempt record on the tape is built by the projection; this module supplies the same
// view to the loop, so the revert happens exactly when the failure is the one the tape shows.

export interface RevertReport {
  reverted: boolean;
  files: { ref: string; version: string }[];
  conflict?: string;
}

export interface RevertOutcome {
  events: Event[];
  report: RevertReport;
}

const refOf = (path: string): string => (path.startsWith("file:") ? path : `file:${path}`);

// The last Patch before a state, or undefined when there is none.
export function lastPatchBefore(state: State, beforeMoveId: string): string | undefined {
  const rootId = state.rootId;
  if (rootId === undefined) return undefined;
  const moves = childrenOf(state, rootId);
  const end = moves.indexOf(beforeMoveId);
  if (end < 0) return undefined;
  let patch: string | undefined;
  for (let i = 0; i < end; i += 1) {
    const moveId = moves[i] as string;
    if (moveIsland(state, moveId) === "patch") patch = moveId;
  }
  return patch;
}

// A move out of a closed Verification whose acceptance run failed. The engine reverts the
// preceding Patch before the move, so Localization OR Patch sees the tree the failed change
// started from; the tape keeps the attempt record (Start/Finish and the failed run).
export function isFailedVerificationMove(state: State, action: Action): boolean {
  if (action.operator !== "move" || (action.state !== "localization" && action.state !== "patch")) {
    return false;
  }
  const move = currentMove(state);
  if (move === undefined) return false;
  if (moveIsland(state, move) !== "verification" || !isMoveFinished(state, move)) return false;
  return lastFailingRun(state, move) !== undefined;
}

// Reverse the edits of the last Patch. Phase 1 supports `edit`: the recorded find/replace is
// enough to restore the pre-patch text without a snapshot. `write`/`apply_patch` need a
// preimage (Phase 2), so a Patch containing them is left untouched and reported as a conflict.
export function revertLastPatch(
  state: State,
  patchMoveId: string,
  workspace: Workspace,
): RevertOutcome {
  const edits: { path: string; oldString: string; newString: string }[] = [];
  for (const actionId of actionsOfMove(state, patchMoveId)) {
    const call = asCall(state.nodes.get(actionId));
    if (call === undefined) continue;
    if (call.name === "write" || call.name === "apply_patch") {
      return {
        events: [],
        report: {
          reverted: false,
          files: [],
          conflict: `${call.name} cannot be reverted without a preimage`,
        },
      };
    }
    if (call.name !== "edit") continue;
    const { filePath, oldString, newString } = call.args;
    if (typeof filePath !== "string" || typeof oldString !== "string" || typeof newString !== "string") {
      return { events: [], report: { reverted: false, files: [], conflict: "malformed edit" } };
    }
    edits.push({ path: filePath, oldString, newString });
  }
  if (edits.length === 0) return { events: [], report: { reverted: false, files: [] } };

  const contents = new Map<string, string>();
  const changed = new Set<string>();
  try {
    for (const edit of edits) {
      if (!contents.has(edit.path)) contents.set(edit.path, workspace.read(edit.path));
    }
    // Reverse in the order the Patch applied them.
    for (let i = edits.length - 1; i >= 0; i -= 1) {
      const edit = edits[i] as (typeof edits)[number];
      const text = contents.get(edit.path) as string;
      if (text.includes(edit.newString)) {
        contents.set(edit.path, text.replace(edit.newString, edit.oldString));
        changed.add(edit.path);
      } else if (!text.includes(edit.oldString)) {
        return {
          events: [],
          report: {
            reverted: false,
            files: [],
            conflict: `neither the patched nor the pre-patch text is present in ${edit.path}`,
          },
        };
      }
    }
    if (changed.size === 0) return { events: [], report: { reverted: false, files: [] } };
    for (const edit of edits) {
      if (!(contents.get(edit.path) as string).includes(edit.oldString)) {
        return {
          events: [],
          report: { reverted: false, files: [], conflict: `the pre-patch text is incomplete in ${edit.path}` },
        };
      }
    }
    const files: { ref: string; version: string }[] = [];
    for (const path of changed) {
      workspace.write(path, contents.get(path) as string);
      files.push({ ref: refOf(path), version: workspace.version(path) });
    }
    return {
      events: [
        { type: "revert", patchMoveId, files, reason: "verification_failed" },
      ],
      report: { reverted: true, files },
    };
  } catch (error) {
    return {
      events: [],
      report: {
        reverted: false,
        files: [],
        conflict: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// The hook used by the loop before a failed Verification's move to Localization.
export function revertFailedPatch(state: State, workspace: Workspace): Event[] {
  const move = currentMove(state);
  if (move === undefined) return [];
  if (moveIsland(state, move) !== "verification" || !isMoveFinished(state, move)) return [];
  if (lastFailingRun(state, move) === undefined) return [];
  const patchMoveId = lastPatchBefore(state, move);
  if (patchMoveId === undefined) return [];
  return revertLastPatch(state, patchMoveId, workspace).events;
}
