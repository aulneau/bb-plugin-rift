import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withFileLock } from "../file-lock.js";

test("cancelling a queued operation preserves the holder's lock and leaves other checkouts available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rift-lock-test-"));
  const lock = path.join(root, "checkout.lock");
  await fs.mkdir(lock);
  try {
    const controller = new AbortController();
    let entered = false;
    const waiting = withFileLock(lock, controller.signal, async () => {
      entered = true;
    });
    const rejected = assert.rejects(waiting);
    assert.equal(
      await withFileLock(
        path.join(root, "other.lock"),
        controller.signal,
        async () => "done",
      ),
      "done",
    );
    controller.abort();
    await rejected;
    assert.equal(entered, false);
    assert.equal((await fs.stat(lock)).isDirectory(), true);
    await assert.rejects(fs.stat(path.join(root, "other.lock")), {
      code: "ENOENT",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
