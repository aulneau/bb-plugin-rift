import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hostSetupDir, runHostSetup } from "../host-setup.js";

test("setup dir follows BB_RIFT_SETUP_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
  assert.equal(hostSetupDir({ BB_RIFT_SETUP_DIR: "/s" }, "/h"), "/s");
  assert.equal(hostSetupDir({ XDG_CONFIG_HOME: "/x" }, "/h"), "/x/bb-rift/setup");
  assert.equal(hostSetupDir({ XDG_CONFIG_HOME: "rel" }, "/h"), "/h/.config/bb-rift/setup");
  assert.equal(hostSetupDir({}, "/h"), "/h/.config/bb-rift/setup");
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rift-setup-"));
  const source = path.join(root, "myrepo");
  const target = path.join(root, "copy");
  const dir = path.join(root, "setup");
  await fs.mkdir(path.join(target, ".git"), { recursive: true });
  await fs.mkdir(source);
  await fs.mkdir(dir);
  return { root, source, target, dir };
}

test("no script for the repo: nothing runs", async () => {
  const f = await fixture();
  const result = await runHostSetup(f.source, f.target, AbortSignal.timeout(5000), f.dir);
  assert.equal(result.status, "skipped");
});

test("the repo's script runs in the copy and logs to .git", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.dir, "myrepo.sh"), 'echo hello; pwd > ran-here\n');
  const result = await runHostSetup(f.source, f.target, AbortSignal.timeout(5000), f.dir);
  assert.equal(result.status, "ran");
  assert.equal((await fs.readFile(path.join(f.target, "ran-here"), "utf8")).trim(), await fs.realpath(f.target));
  assert.match(await fs.readFile(path.join(f.target, ".git", "bb-rift-setup.log"), "utf8"), /hello/);
});

test("a failing script fails with the log's tail", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.dir, "myrepo.sh"), 'echo "install broke"; exit 3\n');
  const result = await runHostSetup(f.source, f.target, AbortSignal.timeout(5000), f.dir);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.message : "", /install broke/);
});
