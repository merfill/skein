import type { SandboxTask } from "../task";

// terminal-bench `db-wal-recovery`: recover an XOR-encrypted SQLite WAL. The image has
// sqlite3 and Python; the verifier reads the recovered database.
export const dbWalRecovery: SandboxTask = {
  id: "db-wal-recovery",
  image: "alexgshaw/db-wal-recovery:20251031",
};
