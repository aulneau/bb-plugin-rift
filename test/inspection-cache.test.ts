import assert from "node:assert/strict";
import { test } from "node:test";
import { createInspectionCache } from "../inspection-cache.js";

const input = { binaryPath: "/rift", sourcePath: "/source" };
const ready = { status: "ready" as const, platform: "darwin-arm64" };
const signal = new AbortController().signal;

test("inspection reads share work, survive one caller cancelling, expire and isolate checkouts", async () => {
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  let now = 0;
  const cache = createInspectionCache(
    async () => {
      calls++;
      await gate;
      return ready;
    },
    () => now,
  );
  try {
    const controller = new AbortController();
    const first = cache.read(input, controller.signal);
    const second = cache.read(input, signal);
    controller.abort();
    await assert.rejects(first);
    finish();
    assert.deepEqual(await second, ready);
    assert.deepEqual(await cache.read(input, signal), ready);
    assert.equal(calls, 1);
    now = 3001;
    await cache.read(input, signal);
    assert.equal(calls, 2);
    await cache.read({ ...input, sourcePath: "/other" }, signal);
    assert.equal(calls, 3);
  } finally {
    finish();
    cache.dispose();
  }
});

test("inspection failures are immediately retryable and disposal cancels owned work", async () => {
  let attempts = 0;
  const cache = createInspectionCache(async (_input, owned) => {
    attempts++;
    if (attempts === 1) return { status: "failed", message: "offline" };
    await new Promise<void>((_resolve, reject) => {
      owned.addEventListener("abort", () => reject(owned.reason), {
        once: true,
      });
      if (owned.aborted) reject(owned.reason);
    });
    return ready;
  });
  assert.equal((await cache.read(input, signal)).status, "failed");
  const pending = cache.read(input, signal);
  await Promise.resolve();
  cache.dispose();
  await assert.rejects(pending);
  assert.equal(attempts, 2);
  await assert.rejects(cache.read(input, signal));
});

test("inspection concurrency is bounded while existing callers can still share work", async () => {
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cache = createInspectionCache(async () => {
    await gate;
    return ready;
  });
  const pending = Array.from({ length: 64 }, (_, index) =>
    cache.read({ ...input, sourcePath: `/source-${index}` }, signal),
  );
  try {
    assert.equal((await cache.read(input, signal)).status, "failed");
    const joined = cache.read({ ...input, sourcePath: "/source-0" }, signal);
    finish();
    assert.deepEqual(await joined, ready);
    await Promise.all(pending);
  } finally {
    finish();
    cache.dispose();
  }
});
