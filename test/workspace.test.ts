import { hostContract } from "../contract.js";
import { defaultProjectOptions } from "../options.js";
import assert from "node:assert/strict";
import { z } from "zod";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCopy, removeCopy } from "../workspace.js";
import { runCommand } from "../process.js";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { makeHostEntry } from "../host.js";

const binaryPath = process.env.RIFT_TEST_BINARY ?? "";
const signal = new AbortController().signal;
async function git(cwd: string, args: string[]) {
  const result = await runCommand(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    cwd,
    signal,
  );
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result.stdout;
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-rift-test-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Rift Test"]);
  await git(source, ["config", "user.email", "rift-test@example.invalid"]);
  await fs.writeFile(path.join(source, "tracked.txt"), "base\n");
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n.env\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "fixture"]);
  await git(root, ["init", "--bare", "-b", "main", remote]);
  await git(source, ["remote", "add", "origin", remote]);
  await git(source, ["push", "-u", "origin", "main"]);
  const input = {
    id: randomUUID(),
    name: "fixture",
    sourcePath: source,
    binaryPath,
    branchName: "bb/rift-fixture",
    options: defaultProjectOptions,
  };
  return { root, source, remote, data: path.join(root, "plugin-data"), input };
}

test(
  "fetches fresh main, keeps ignored dependencies, preserves source edits, and retains independent commits on removal",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      const publisher = path.join(f.root, "publisher");
      await git(f.root, ["clone", f.remote, publisher]);
      await fs.writeFile(
        path.join(publisher, "tracked.txt"),
        "latest remote main\n",
      );
      await git(publisher, ["add", "."]);
      await git(publisher, [
        "-c",
        "user.name=Rift Test",
        "-c",
        "user.email=rift-test@example.invalid",
        "commit",
        "-m",
        "remote advanced",
      ]);
      await git(publisher, ["push", "origin", "main"]);
      const latestMain = await git(publisher, ["rev-parse", "HEAD"]);
      await git(f.source, ["switch", "-c", "feature"]);
      await fs.writeFile(path.join(f.source, "feature-only.txt"), "feature\n");
      await git(f.source, ["add", "."]);
      await git(f.source, ["commit", "-m", "local feature"]);
      await fs.writeFile(path.join(f.source, "tracked.txt"), "staged\n");
      await git(f.source, ["add", "tracked.txt"]);
      await fs.writeFile(path.join(f.source, "tracked.txt"), "unstaged\n");
      await fs.writeFile(path.join(f.source, "new.txt"), "untracked\n");
      await fs.writeFile(path.join(f.source, ".env"), "FIXTURE=true\n");
      await fs.mkdir(path.join(f.source, "node_modules", "fixture"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(f.source, "node_modules/fixture/index.js"),
        "dependency\n",
      );
      const before = await git(f.source, ["status", "--porcelain"]);
      const beforeHead = await git(f.source, ["rev-parse", "HEAD"]);
      assert.notEqual(
        await git(f.source, ["rev-parse", "origin/main"]),
        latestMain,
      );
      const created = await createCopy(f.input, f.data, signal);
      assert.equal(created.status, "created", JSON.stringify(created));
      if (created.status !== "created") return;
      const target = created.copy.path;
      assert.equal(created.copy.startingCommit, latestMain);
      assert.equal(await git(target, ["rev-parse", "HEAD"]), latestMain);
      assert.equal(
        await git(target, ["branch", "--show-current"]),
        f.input.branchName,
      );
      assert.equal(await git(target, ["status", "--porcelain"]), "");
      assert.equal(
        await fs.readFile(path.join(target, "tracked.txt"), "utf8"),
        "latest remote main\n",
      );
      await assert.rejects(fs.stat(path.join(target, "new.txt")));
      await assert.rejects(fs.stat(path.join(target, "feature-only.txt")));
      assert.equal(
        await fs.readFile(path.join(target, ".env"), "utf8"),
        "FIXTURE=true\n",
      );
      assert.equal(
        await fs.readFile(
          path.join(target, "node_modules/fixture/index.js"),
          "utf8",
        ),
        "dependency\n",
      );
      assert.equal(
        await git(f.source, ["branch", "--show-current"]),
        "feature",
      );
      assert.equal(await git(f.source, ["rev-parse", "HEAD"]), beforeHead);
      assert.equal(await git(f.source, ["status", "--porcelain"]), before);
      assert.equal(await git(f.source, ["show", ":tracked.txt"]), "staged");
      assert.equal(
        await fs.readFile(path.join(f.source, "tracked.txt"), "utf8"),
        "unstaged\n",
      );
      await fs.writeFile(
        path.join(target, "tracked.txt"),
        "independent child\n",
      );
      await git(target, ["add", "."]);
      await git(target, ["commit", "-m", "child-only commit"]);
      const childHead = await git(target, ["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(target, "unsaved.txt"), "retain me\n");
      assert.deepEqual(await createCopy(f.input, f.data, signal), created);
      assert.equal(await git(target, ["rev-parse", "HEAD"]), childHead);
      assert.equal(
        (await createCopy({ ...f.input, name: "different" }, f.data, signal))
          .status,
        "failed",
      );
      const removed = await removeCopy(
        { id: f.input.id, binaryPath },
        f.data,
        signal,
      );
      assert.equal(removed.status, "removed", JSON.stringify(removed));
      if (removed.status !== "removed" || removed.retainedPath === null)
        throw new Error("Missing retained copy");
      await assert.rejects(fs.stat(target));
      assert.equal(
        await git(removed.retainedPath, ["rev-parse", "HEAD"]),
        childHead,
      );
      assert.equal(
        await fs.readFile(
          path.join(removed.retainedPath, "unsaved.txt"),
          "utf8",
        ),
        "retain me\n",
      );
      assert.deepEqual(
        await removeCopy({ id: f.input.id, binaryPath }, f.data, signal),
        removed,
      );
      assert.equal(await git(f.source, ["rev-parse", "HEAD"]), beforeHead);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "fetch failure refuses stale main and does not create a copy",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      await fs.rename(f.remote, `${f.remote}.offline`);
      const result = await createCopy(f.input, f.data, signal);
      assert.equal(result.status, "failed");
      if (result.status === "failed")
        assert.match(result.message, /Could not fetch latest origin\/main/);
      assert.deepEqual(await fs.readdir(path.join(f.data, "copies")), []);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "refuses linked worktrees and unrecognized Rift markers without changing ownership",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      const linked = path.join(f.root, "linked");
      await git(f.source, ["worktree", "add", "-b", "linked", linked]);
      const result = await createCopy(
        { ...f.input, sourcePath: linked },
        f.data,
        signal,
      );
      assert.equal(result.status, "failed");
      if (result.status === "failed")
        assert.match(result.message, /linked Git worktree/);
      await assert.rejects(fs.stat(path.join(linked, ".rift")));
      await fs.writeFile(
        path.join(f.source, ".rift"),
        "existing-user-marker\n",
      );
      assert.equal(
        (await createCopy(f.input, f.data, signal)).status,
        "failed",
      );
      assert.equal(
        await fs.readFile(path.join(f.source, ".rift"), "utf8"),
        "existing-user-marker\n",
      );
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "real host contract creates and removes a copy and rejects invalid IDs",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    const harness = experimental_createHostEntryHarness(makeHostEntry(), {
      experimental_paths: {
        dataDir: f.data,
        tempDir: path.join(f.root, "tmp"),
      },
    });
    try {
      const created = await harness.experimental_call("create", f.input);
      assert.equal(created.status, "created", JSON.stringify(created));
      await assert.rejects(
        harness.experimental_call("create", { ...f.input, id: "../../bad" }),
      );
      const removed = await harness.experimental_call("remove", {
        id: f.input.id,
        binaryPath,
      });
      assert.equal(removed.status, "removed", JSON.stringify(removed));
    } finally {
      await harness.experimental_dispose();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test("cancellation terminates a running subprocess", async () => {
  const controller = new AbortController();
  const operation = runCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    os.tmpdir(),
    controller.signal,
  );
  controller.abort();
  const result = await operation;
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.message, /cancelled/);
});

test(
  "removal refuses registered descendants and recovers an interrupted creation",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      const created = await createCopy(f.input, f.data, signal);
      assert.equal(created.status, "created", JSON.stringify(created));
      if (created.status !== "created") return;
      const plan = z
        .object({ database: z.string().startsWith("/") })
        .parse(
          JSON.parse(
            await fs.readFile(
              path.join(f.data, "copies", `${f.input.id}.plan.json`),
              "utf8",
            ),
          ),
        );
      const child = await runCommand(
        binaryPath,
        [
          "--database",
          plan.database,
          "create",
          created.copy.path,
          "--into",
          f.root,
          "--name",
          "child",
          "--copy-all",
          "--no-hooks",
        ],
        f.root,
        signal,
      );
      assert.equal(child.status, "ok", JSON.stringify(child));
      const refused = await removeCopy(
        { id: f.input.id, binaryPath },
        f.data,
        signal,
      );
      assert.equal(refused.status, "failed");
      if (refused.status === "failed")
        assert.match(refused.message, /child copies/);
      assert.equal(
        await fs.readFile(path.join(f.root, "child", "tracked.txt"), "utf8"),
        "base\n",
      );
      const broken = {
        ...f.input,
        id: randomUUID(),
        name: "interrupted",
        branchName: "invalid..branch",
      };
      const interrupted = await createCopy(broken, f.data, signal);
      assert.equal(interrupted.status, "failed");
      const retained = await removeCopy(
        { id: broken.id, binaryPath },
        f.data,
        signal,
      );
      assert.equal(retained.status, "removed", JSON.stringify(retained));
      if (retained.status !== "removed" || retained.retainedPath === null)
        throw new Error("Missing partial snapshot");
      assert.equal(
        await fs.readFile(
          path.join(retained.retainedPath, "tracked.txt"),
          "utf8",
        ),
        "base\n",
      );
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "reuses a verified existing registry without changing its source marker or sibling copy",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      const registry = path.join(f.root, "user-rift.sqlite");
      const initialized = await runCommand(
        binaryPath,
        ["--database", registry, "init", f.source, "--here"],
        f.root,
        signal,
      );
      assert.equal(initialized.status, "ok", JSON.stringify(initialized));
      const sibling = await runCommand(
        binaryPath,
        [
          "--database",
          registry,
          "create",
          f.source,
          "--into",
          f.root,
          "--name",
          "existing-sibling",
          "--copy-all",
          "--no-hooks",
        ],
        f.root,
        signal,
      );
      assert.equal(sibling.status, "ok", JSON.stringify(sibling));
      const marker = await fs.readFile(path.join(f.source, ".rift"), "utf8");
      const created = await createCopy(f.input, f.data, signal, [registry]);
      assert.equal(created.status, "created", JSON.stringify(created));
      const removed = await removeCopy(
        { id: f.input.id, binaryPath },
        f.data,
        signal,
      );
      assert.equal(removed.status, "removed", JSON.stringify(removed));
      assert.equal(
        await fs.readFile(path.join(f.source, ".rift"), "utf8"),
        marker,
      );
      assert.equal(
        await fs.readFile(
          path.join(f.root, "existing-sibling", "tracked.txt"),
          "utf8",
        ),
        "base\n",
      );
      const remaining = await runCommand(
        binaryPath,
        ["--database", registry, "list", f.source],
        f.root,
        signal,
      );
      assert.equal(remaining.status, "ok");
      if (remaining.status === "ok")
        assert.equal(
          remaining.stdout,
          await fs.realpath(path.join(f.root, "existing-sibling")),
        );
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "simultaneous copies serialize and completed retries need neither source nor executable",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      const other = {
        ...f.input,
        id: randomUUID(),
        name: "second",
        branchName: "bb/second",
      };
      const [first, second] = await Promise.all([
        createCopy(f.input, f.data, signal),
        createCopy(other, f.data, signal),
      ]);
      assert.equal(first.status, "created", JSON.stringify(first));
      assert.equal(second.status, "created", JSON.stringify(second));
      const sourceLock = path.join(
        f.data,
        `${createHash("sha256").update(f.source).digest("hex")}.lock`,
      );
      await fs.mkdir(sourceLock);
      await fs.rename(f.source, `${f.source}-moved`);
      assert.deepEqual(
        await createCopy(
          { ...f.input, binaryPath: "/missing/rift" },
          f.data,
          AbortSignal.timeout(1000),
        ),
        first,
      );
      await fs.rmdir(sourceLock);
      const [removed, retry] = await Promise.all([
        removeCopy({ id: f.input.id, binaryPath }, f.data, signal),
        removeCopy({ id: f.input.id, binaryPath }, f.data, signal),
      ]);
      assert.equal(removed.status, "removed", JSON.stringify(removed));
      assert.deepEqual(retry, removed);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "inherited Git repository overrides cannot redirect operations away from the copy",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    const inherited = {
      gitDir: process.env.GIT_DIR,
      workTree: process.env.GIT_WORK_TREE,
      index: process.env.GIT_INDEX_FILE,
    };
    try {
      await fs.writeFile(
        path.join(f.source, "tracked.txt"),
        "keep original dirty contents\n",
      );
      process.env.GIT_DIR = path.join(f.source, ".git");
      process.env.GIT_WORK_TREE = f.source;
      process.env.GIT_INDEX_FILE = path.join(f.source, ".git", "index");
      const result = await createCopy(f.input, f.data, signal);
      assert.equal(result.status, "created", JSON.stringify(result));
      assert.equal(
        await fs.readFile(path.join(f.source, "tracked.txt"), "utf8"),
        "keep original dirty contents\n",
      );
      assert.equal(await git(f.source, ["branch", "--show-current"]), "main");
      if (result.status === "created")
        assert.equal(
          await fs.readFile(path.join(result.copy.path, "tracked.txt"), "utf8"),
          "base\n",
        );
    } finally {
      for (const [key, value] of [
        ["GIT_DIR", inherited.gitDir],
        ["GIT_WORK_TREE", inherited.workTree],
        ["GIT_INDEX_FILE", inherited.index],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "copy IDs cannot be reused across different sources",
  { skip: binaryPath === "" },
  async () => {
    const first = await fixture();
    const second = await fixture();
    try {
      const results = await Promise.all([
        createCopy(first.input, first.data, signal),
        createCopy({ ...second.input, id: first.input.id }, first.data, signal),
      ]);
      assert.equal(
        results.filter((result) => result.status === "created").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "failed").length,
        1,
      );
    } finally {
      await fs.rm(first.root, { recursive: true, force: true });
      await fs.rm(second.root, { recursive: true, force: true });
    }
  },
);

test(
  "offline creation uses the cached configured branch and refuses a missing ref",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      await git(f.source, ["switch", "-c", "release/next"]);
      await fs.writeFile(path.join(f.source, "release.txt"), "release\n");
      await git(f.source, ["add", "."]);
      await git(f.source, ["commit", "-m", "release"]);
      await git(f.source, ["push", "origin", "release/next"]);
      const commit = await git(f.source, ["rev-parse", "origin/release/next"]);
      await git(f.source, [
        "remote",
        "set-url",
        "origin",
        path.join(f.root, "offline.git"),
      ]);
      const options = {
        ...defaultProjectOptions,
        startingBranch: "origin/release/next",
        fetchBeforeCreate: false,
      };
      const created = await createCopy({ ...f.input, options }, f.data, signal);
      assert.equal(created.status, "created", JSON.stringify(created));
      if (created.status !== "created") return;
      assert.equal(created.copy.startingBranch, options.startingBranch);
      assert.equal(created.copy.startingCommit, commit);
      assert.equal(await git(created.copy.path, ["rev-parse", "HEAD"]), commit);
      const missing = await createCopy(
        {
          ...f.input,
          id: randomUUID(),
          options: { ...options, startingBranch: "origin/missing" },
        },
        f.data,
        signal,
      );
      assert.equal(missing.status, "failed");
      if (missing.status === "failed")
        assert.match(missing.message, /No cached origin\/missing/);
      const fresh = await createCopy(
        {
          ...f.input,
          id: randomUUID(),
          options: { ...options, fetchBeforeCreate: true },
        },
        f.data,
        signal,
      );
      assert.equal(fresh.status, "failed");
      if (fresh.status === "failed")
        assert.match(
          fresh.message,
          /Could not fetch latest origin\/release\/next/,
        );
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "fetches the configured remote branch even when no local tracking ref exists",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      await git(f.source, ["switch", "-c", "develop"]);
      await fs.writeFile(path.join(f.source, "tracked.txt"), "develop\n");
      await git(f.source, ["add", "."]);
      await git(f.source, ["commit", "-m", "develop"]);
      const commit = await git(f.source, ["rev-parse", "HEAD"]);
      await git(f.source, ["push", "origin", "develop"]);
      await git(f.source, ["update-ref", "-d", "refs/remotes/origin/develop"]);
      await git(f.source, ["switch", "main"]);
      const created = await createCopy(
        {
          ...f.input,
          options: {
            ...defaultProjectOptions,
            startingBranch: "origin/develop",
          },
        },
        f.data,
        signal,
      );
      assert.equal(created.status, "created", JSON.stringify(created));
      if (created.status !== "created") return;
      assert.equal(created.copy.startingCommit, commit);
      assert.equal(
        await fs.readFile(path.join(created.copy.path, "tracked.txt"), "utf8"),
        "develop\n",
      );
      assert.equal(await git(f.source, ["branch", "--show-current"]), "main");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "dependency cleanup preserves tracked artifacts, local configuration and source files",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    try {
      await fs.appendFile(
        path.join(f.source, ".gitignore"),
        "dist/\nbuild/\n.next/\n.env.*\nprivate-data/\n",
      );
      await fs.mkdir(path.join(f.source, "dist"));
      await fs.writeFile(
        path.join(f.source, "dist/tracked.txt"),
        "keep tracked\n",
      );
      await git(f.source, ["add", ".gitignore"]);
      await git(f.source, ["add", "-f", "dist/tracked.txt"]);
      await git(f.source, ["commit", "-m", "tracked artifact"]);
      await git(f.source, ["push", "origin", "main"]);
      const removed = [
        "node_modules/pkg/index.js",
        "packages/app/node_modules/pkg/index.js",
        "dist/cache.js",
        "packages/app/.next/cache/data",
      ];
      const kept = [
        ".env",
        ".env.local",
        "packages/app/.env.local",
        "private-data/notes.txt",
      ];
      for (const name of [...removed, ...kept]) {
        const file = path.join(f.source, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "fixture\n");
      }
      const external = path.join(f.root, "external-venv");
      await fs.mkdir(external);
      await fs.writeFile(path.join(external, "keep.txt"), "external\n");
      await fs.appendFile(
        path.join(f.source, ".git/info/exclude"),
        "\n.venv\n",
      );
      await fs.symlink(external, path.join(f.source, ".venv"));
      const created = await createCopy(
        {
          ...f.input,
          options: { ...defaultProjectOptions, reuseDependencies: false },
        },
        f.data,
        signal,
      );
      assert.equal(created.status, "created", JSON.stringify(created));
      if (created.status !== "created") return;
      await assert.rejects(fs.lstat(path.join(created.copy.path, ".venv")), {
        code: "ENOENT",
      });
      assert.equal(
        await fs.readFile(path.join(external, "keep.txt"), "utf8"),
        "external\n",
      );
      assert.equal(
        (await fs.lstat(path.join(f.source, ".venv"))).isSymbolicLink(),
        true,
      );
      for (const name of removed) {
        await assert.rejects(fs.stat(path.join(created.copy.path, name)), {
          code: "ENOENT",
        });
        assert.equal(
          await fs.readFile(path.join(f.source, name), "utf8"),
          "fixture\n",
        );
      }
      for (const name of kept)
        assert.equal(
          await fs.readFile(path.join(created.copy.path, name), "utf8"),
          "fixture\n",
        );
      assert.equal(
        await fs.readFile(
          path.join(created.copy.path, "dist/tracked.txt"),
          "utf8",
        ),
        "keep tracked\n",
      );
      assert.equal(await git(created.copy.path, ["status", "--porcelain"]), "");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "discovers Rift on PATH and recovers legacy receipts without applying changed settings",
  { skip: binaryPath === "" },
  async () => {
    const f = await fixture();
    const originalPath = process.env.PATH;
    try {
      const bin = path.join(f.root, "bin");
      await fs.mkdir(bin);
      await fs.symlink(binaryPath, path.join(bin, "rift"));
      process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
      const input = { ...f.input, binaryPath: "" };
      const created = await createCopy(input, f.data, signal);
      assert.equal(created.status, "created", JSON.stringify(created));
      if (created.status !== "created") return;
      const {
        startingBranch: _startingBranch,
        startingCommit,
        ...legacy
      } = created.copy;
      await fs.writeFile(
        path.join(f.data, "copies", `${input.id}.json`),
        JSON.stringify({ ...legacy, mainCommit: startingCommit }),
      );
      const planFile = path.join(f.data, "copies", `${input.id}.plan.json`);
      const plan = z
        .object({
          input: hostContract.create.input,
          target: z.string(),
          source: z.string(),
          database: z.string(),
          retainedPath: z.string().nullable(),
        })
        .parse(JSON.parse(await fs.readFile(planFile, "utf8")));
      const { options: _options, ...legacyInput } = plan.input;
      await fs.writeFile(
        planFile,
        JSON.stringify({ ...plan, input: legacyInput }),
      );
      await fs.writeFile(
        path.join(created.copy.path, "tracked.txt"),
        "independent edit\n",
      );
      const retry = await createCopy(
        {
          ...input,
          options: {
            fetchBeforeCreate: false,
            startingBranch: "origin/changed",
            reuseDependencies: false,
          },
        },
        f.data,
        signal,
      );
      assert.deepEqual(retry, created);
      assert.equal(
        await fs.readFile(path.join(created.copy.path, "tracked.txt"), "utf8"),
        "independent edit\n",
      );
      const removed = await removeCopy(
        { id: input.id, binaryPath: "" },
        f.data,
        signal,
      );
      assert.equal(removed.status, "removed", JSON.stringify(removed));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "a missing runtime stays selectable and installs automatically through the host creation contract",
  { skip: binaryPath === "" },
  async () => {
    const { createRuntimeManager, probeRuntime } =
      await import("../runtime.js");
    const { resolveExecutable } = await import("../executable.js");
    const f = await fixture();
    let downloads = 0;
    const entry = makeHostEntry((dataDir) =>
      createRuntimeManager(dataDir, {
        latest: async () => ({
          version: "0.0.10",
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        }),
        download: async (_release, _platform, directory) => {
          downloads++;
          await fs.copyFile(binaryPath, path.join(directory, "rift"));
          await fs.chmod(path.join(directory, "rift"), 0o700);
        },
        discover: (override) =>
          override === ""
            ? Promise.resolve({ status: "failed", message: "missing" })
            : resolveExecutable(override),
        probe: probeRuntime,
        now: Date.now,
        platform: "darwin-arm64",
      }),
    );
    const harness = experimental_createHostEntryHarness(entry, {
      experimental_paths: {
        dataDir: f.data,
        tempDir: path.join(f.root, "temp"),
      },
    });
    try {
      const availability = await harness.experimental_call("inspect", {
        binaryPath: "",
        sourcePath: f.source,
      });
      assert.equal(availability.status, "ready");
      assert.equal(downloads, 0);
      const created = await harness.experimental_call("create", {
        ...f.input,
        binaryPath: "",
      });
      assert.equal(created.status, "created", JSON.stringify(created));
      assert.equal(downloads, 1);
      const retry = await harness.experimental_call("create", {
        ...f.input,
        binaryPath: "/missing/override",
      });
      assert.deepEqual(retry, created);
      assert.equal(downloads, 1);
      const removed = await harness.experimental_call("remove", {
        id: f.input.id,
        binaryPath: "",
      });
      assert.equal(removed.status, "removed", JSON.stringify(removed));
    } finally {
      await harness.experimental_dispose();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);
