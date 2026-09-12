import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "../process.js";

const signal = new AbortController().signal;
test("command output preserves split UTF-8 and meaningful spaces", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "const b=Buffer.from('🙂 trailing space \\n');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)",
    ],
    os.tmpdir(),
    signal,
  );
  assert.deepEqual(result, { status: "ok", stdout: "🙂 trailing space " });
});

test("command output is bounded in bytes and a missing executable fails", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('🙂'.repeat(40000))"],
    os.tmpdir(),
    signal,
  );
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.message, /128 KB/);
  assert.equal(
    (await runCommand("/does-not-exist/rift", [], os.tmpdir(), signal)).status,
    "failed",
  );
});

test(
  "cancellation kills descendants even if the parent closes its pipes first",
  { timeout: 5000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-process-"));
    const pidFile = path.join(dir, "pid");
    const controller = new AbortController();
    let pid: number | null = null;
    const operation = runCommand(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});setTimeout(()=>fs.writeFileSync(process.argv[1],String(child.pid)),150);setInterval(()=>{},1000)`,
        pidFile,
      ],
      dir,
      controller.signal,
    );
    try {
      for (let i = 0; i < 50; i++) {
        const text = await fs.readFile(pidFile, "utf8").catch(() => null);
        if (text !== null) {
          pid = Number(text);
          break;
        }
        await delay(20);
      }
      assert.ok(pid !== null && Number.isSafeInteger(pid) && pid > 0);
      controller.abort();
      assert.equal((await operation).status, "failed");
      let alive = true;
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await delay(20);
      }
      assert.equal(alive, false, "cancelled command left a live grandchild");
    } finally {
      controller.abort();
      await operation;
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
