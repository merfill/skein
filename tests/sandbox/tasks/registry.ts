import type { SandboxTask } from "../task";
import { cobolModernization } from "./cobol-modernization";
import { crack7zHash } from "./crack-7z-hash";
import { customMemoryHeapCrash } from "./custom-memory-heap-crash";
import { dbWalRecovery } from "./db-wal-recovery";
import { fixCodeVulnerability } from "./fix-code-vulnerability";
import { fixGit } from "./fix-git";
import { fixOcamlGcTask } from "./fix-ocaml-gc";
import { gitLeakRecovery } from "./git-leak-recovery";
import { logSummaryDateRanges } from "./log-summary-date-ranges";
import { modernizeScientificStack } from "./modernize-scientific-stack";
import { opensslSelfsignedCert } from "./openssl-selfsigned-cert";
import { passwordRecovery } from "./password-recovery";
import { regexLog } from "./regex-log";

// Ported terminal-bench tasks, keyed by id. Add a task by porting its environment here.
export const TASKS: Record<string, SandboxTask> = {
  [regexLog.id]: regexLog,
  [fixGit.id]: fixGit,
  [logSummaryDateRanges.id]: logSummaryDateRanges,
  [opensslSelfsignedCert.id]: opensslSelfsignedCert,
  [gitLeakRecovery.id]: gitLeakRecovery,
  [cobolModernization.id]: cobolModernization,
  [modernizeScientificStack.id]: modernizeScientificStack,
  [fixOcamlGcTask.id]: fixOcamlGcTask,
  [customMemoryHeapCrash.id]: customMemoryHeapCrash,
  [passwordRecovery.id]: passwordRecovery,
  [crack7zHash.id]: crack7zHash,
  [dbWalRecovery.id]: dbWalRecovery,
  [fixCodeVulnerability.id]: fixCodeVulnerability,
};
