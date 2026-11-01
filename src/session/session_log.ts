import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// A persistent JSONL trace of one session. The TUI keeps telemetry in memory; without a
// file, a long task can only be judged from the (incomplete) observation store. The log
// carries the briefs and turn/tool/usage metadata, not full tool outputs.
export interface SessionLog {
  readonly path: string;
  write(event: Record<string, unknown>): void;
  close(): void;
}

export function createSessionLog(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionLog {
  const setting = env.SKEIN_LOG;
  if (setting === "off" || setting === "false" || setting === "0") {
    return { path: "", write: () => {}, close: () => {} };
  }
  const path =
    setting === undefined || setting === "" || setting === "1" || setting === "true"
      ? join(root, ".skein", "session.log")
      : resolve(setting);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  let closed = false;
  return {
    path,
    write(event) {
      if (closed) return;
      try {
        appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
      } catch {
        // A log failure must never break the session.
      }
    },
    close() {
      closed = true;
    },
  };
}
