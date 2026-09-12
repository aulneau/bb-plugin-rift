import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRuntimeManager } from "../runtime.js";
import { resolveExecutable } from "../executable.js";
import { extractExecutable, downloadRelease } from "../runtime-download.js";
import { runCommand } from "../process.js";

const signal = new AbortController().signal;
const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rift-runtime-test-"));
  let now = 100_000;
  let version = "0.0.10";
  let networkError: string | null = null;
  let invalidDownload = false;
  let downloads = 0;
  let checks = 0;
  const manager = createRuntimeManager(root, {
    latest: async () => {
      checks++;
      if (networkError !== null) throw new Error(networkError);
      return { version, integrity };
    },
    download: async (_release, _platform, directory, downloadSignal) => {
      downloads++;
      downloadSignal.throwIfAborted();
      await fs.writeFile(
        path.join(directory, "rift"),
        invalidDownload ? "invalid" : "executable",
        { mode: 0o700 },
      );
    },
    discover: (override) =>
      override === ""
        ? Promise.resolve({ status: "failed", message: "missing" })
        : resolveExecutable(override),
    probe: async (binary) =>
      (await fs.readFile(binary, "utf8")) === "executable"
        ? null
        : "Incompatible release",
    now: () => now,
    platform: "darwin-arm64",
  });
  return {
    root,
    manager,
    counts: () => ({ downloads, checks }),
    advance: () => {
      now += 25 * 60 * 60 * 1000;
    },
    release: (next: string) => {
      version = next;
    },
    offline: () => {
      networkError = "Network unavailable";
    },
    invalid: () => {
      invalidDownload = true;
    },
  };
}

test("first use installs once under concurrency; status stays local and daily updates retain older executables", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.manager.run("", "status", signal)).installation.status,
      "missing",
    );
    await f.manager.run("", "maintain", signal);
    assert.deepEqual(f.counts(), { downloads: 0, checks: 0 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.manager.run("", "ensure", signal)),
    );
    for (const result of results)
      assert.equal(result.installation.status, "ready", JSON.stringify(result));
    assert.deepEqual(f.counts(), { downloads: 1, checks: 1 });
    const original = results[0]?.installation;
    assert.ok(original?.status === "ready");
    f.release("0.0.11");
    await f.manager.run("", "ensure", signal);
    assert.deepEqual(f.counts(), { downloads: 1, checks: 1 });
    const checked = await f.manager.run("", "check", signal);
    assert.equal(checked.latestVersion, "0.0.11");
    assert.equal(
      checked.installation.status === "ready" && checked.installation.version,
      "0.0.10",
    );
    f.advance();
    const updated = await f.manager.run("", "maintain", signal);
    assert.equal(
      updated.installation.status === "ready" && updated.installation.version,
      "0.0.11",
    );
    assert.equal(await fs.readFile(original.binaryPath, "utf8"), "executable");
    f.release("0.0.9");
    const older = await f.manager.run("", "update", signal);
    assert.equal(
      older.installation.status === "ready" && older.installation.version,
      "0.0.11",
    );
    assert.deepEqual(f.counts(), { downloads: 2, checks: 4 });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("offline and incompatible updates keep the working version and throttle automatic retry", async () => {
  const f = await fixture();
  try {
    const original = await f.manager.run("", "ensure", signal);
    f.release("0.0.11");
    f.invalid();
    const rejected = await f.manager.run("", "update", signal);
    assert.deepEqual(rejected.installation, original.installation);
    assert.match(rejected.updateError ?? "", /Incompatible/);
    assert.ok(
      !(await fs.readdir(path.join(f.root, "runtime"))).some((file) =>
        file.startsWith(".install-"),
      ),
    );
    f.advance();
    f.offline();
    const offline = await f.manager.run("", "ensure", signal);
    assert.deepEqual(offline.installation, original.installation);
    assert.match(offline.updateError ?? "", /Network unavailable/);
    const before = f.counts();
    await f.manager.run("", "ensure", signal);
    assert.deepEqual(f.counts(), before);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("explicit installations are never downloaded or modified, including invalid overrides", async () => {
  const f = await fixture();
  try {
    const binary = path.join(f.root, "external-rift");
    await fs.writeFile(binary, "executable", { mode: 0o700 });
    for (const action of [
      "status",
      "check",
      "ensure",
      "maintain",
      "update",
      "install",
    ] as const) {
      const result = await f.manager.run(binary, action, signal);
      assert.equal(
        result.installation.status === "ready" && result.installation.source,
        "override",
      );
    }
    const missing = await f.manager.run(
      path.join(f.root, "missing"),
      "ensure",
      signal,
    );
    assert.equal(missing.installation.status, "failed");
    assert.deepEqual(f.counts(), { checks: 0, downloads: 0 });
    assert.equal(await fs.readFile(binary, "utf8"), "executable");
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("cancelling an install leaves no active version or lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rift-runtime-cancel-"));
  const controller = new AbortController();
  const manager = createRuntimeManager(root, {
    latest: async () => ({ version: "0.0.10", integrity }),
    download: async (_release, _platform, directory, owned) => {
      await fs.writeFile(path.join(directory, "rift"), "partial");
      controller.abort(new Error("Cancelled fixture"));
      owned.throwIfAborted();
    },
    discover: async () => ({ status: "failed", message: "missing" }),
    probe: async () => null,
    now: Date.now,
    platform: "darwin-arm64",
  });
  try {
    await assert.rejects(
      manager.run("", "ensure", controller.signal),
      /Cancelled/,
    );
    const files = await fs.readdir(path.join(root, "runtime"));
    assert.ok(
      !files.some(
        (file) => file.startsWith(".install-") || file.endsWith(".lock"),
      ),
    );
    const saved = JSON.parse(
      await fs.readFile(path.join(root, "runtime/state.json"), "utf8"),
    );
    assert.equal(saved.active, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("archive extraction writes only the selected executable and rejects missing members", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rift-extract-test-"));
  try {
    await fs.mkdir(path.join(root, "package/prebuilds/darwin-arm64"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "package/prebuilds/darwin-arm64/rift"),
      Buffer.from([0, 255, 10, 128]),
    );
    await fs.writeFile(path.join(root, "package/untouched"), "unrelated");
    const packed = await runCommand(
      "/usr/bin/tar",
      ["-czf", "fixture.tgz", "package"],
      root,
      signal,
    );
    assert.equal(packed.status, "ok");
    await extractExecutable(
      path.join(root, "fixture.tgz"),
      "package/prebuilds/darwin-arm64/rift",
      path.join(root, "rift"),
      signal,
    );
    assert.deepEqual(
      await fs.readFile(path.join(root, "rift")),
      Buffer.from([0, 255, 10, 128]),
    );
    await assert.rejects(
      extractExecutable(
        path.join(root, "fixture.tgz"),
        "package/missing",
        path.join(root, "missing"),
        signal,
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("download integrity failure leaves no extracted executable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rift-integrity-test-"));
  try {
    await assert.rejects(
      downloadRelease(
        { version: "0.0.10", integrity },
        "darwin-arm64",
        root,
        signal,
        async () => Buffer.from("tampered archive"),
      ),
      /integrity verification failed/,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
