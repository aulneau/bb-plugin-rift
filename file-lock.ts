import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

type LockFailure = { status: "busy"; message: string };
export async function withFileLock<T>(
  file: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T | LockFailure> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    try {
      await fs.mkdir(file);
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      if (performance.now() >= deadline)
        return {
          status: "busy",
          message:
            "Another Rift operation is still holding " +
            file +
            ". After a worker crash, check for running Rift processes before removing a stale lock.",
        };
      await delay(50, undefined, { signal });
    }
  }
  try {
    signal.throwIfAborted();
    return await operation();
  } finally {
    await fs.rmdir(file);
  }
}
