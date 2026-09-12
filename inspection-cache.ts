import type { z } from "zod";
import type { hostContract } from "./contract.js";

type Input = z.infer<typeof hostContract.inspect.input>;
type Result = z.infer<typeof hostContract.inspect.output>;
type Entry = { result: Promise<Result>; expiresAt: number };

export function createInspectionCache(
  inspect: (input: Input, signal: AbortSignal) => Promise<Result>,
  now: () => number = performance.now.bind(performance),
) {
  const entries = new Map<string, Entry>();
  const lifetime = new AbortController();
  return {
    async read(input: Input, signal: AbortSignal): Promise<Result> {
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      for (const [key, entry] of entries)
        if (entry.expiresAt <= now()) entries.delete(key);
      const key = JSON.stringify(input);
      let entry = entries.get(key);
      if (entry === undefined) {
        if (entries.size >= 64)
          return {
            status: "failed",
            message:
              "Too many checkout inspections are in progress. Try again shortly.",
          };
        const owned = AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(10_000),
        ]);
        const result = Promise.resolve().then(() => inspect(input, owned));
        const created: Entry = { result, expiresAt: Infinity };
        entries.set(key, created);
        void result.then(
          (value) => {
            if (value.status === "ready") created.expiresAt = now() + 3000;
            else entries.delete(key);
          },
          () => entries.delete(key),
        );
        entry = created;
      }
      return new Promise<Result>((resolve, reject) => {
        const aborted = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => signal.removeEventListener("abort", aborted);
        signal.addEventListener("abort", aborted, { once: true });
        entry.result.then(
          (result) => {
            cleanup();
            resolve(result);
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
        if (signal.aborted) aborted();
      });
    },
    invalidate() {
      entries.clear();
    },
    dispose() {
      lifetime.abort();
      entries.clear();
    },
  };
}
