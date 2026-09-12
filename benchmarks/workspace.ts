import { defaultProjectOptions } from "../options.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCopy } from "../workspace.js";
import { runCommand } from "../process.js";
import { makeHostEntry } from "../host.js";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

const binaryPath = process.env.RIFT_TEST_BINARY ?? "";
if (!binaryPath) throw new Error("Set RIFT_TEST_BINARY.");
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "rift-benchmark-")),
);
const source = path.join(root, "source");
const data = path.join(root, "data");
const signal = new AbortController().signal;
const harness = experimental_createHostEntryHarness(makeHostEntry(), {
  experimental_paths: { dataDir: data, tempDir: path.join(root, "tmp") },
});
async function git(cwd: string, args: string[]) {
  const result = await runCommand(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    cwd,
    signal,
  );
  assert.equal(result.status, "ok", JSON.stringify(result));
}
try {
  await fs.mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Rift Benchmark"]);
  await git(source, ["config", "user.email", "benchmark@example.invalid"]);
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n");
  for (const [base, groups] of [
    ["src", 10],
    ["node_modules", 40],
  ] as const) {
    for (let group = 0; group < groups; group++) {
      const dir = path.join(source, base, `${group}`);
      await fs.mkdir(dir, { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          fs.writeFile(
            path.join(dir, `${i}.js`),
            "export const value = 1;\n".repeat(12),
          ),
        ),
      );
    }
  }
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "benchmark fixture"]);
  const remote = path.join(root, "remote.git");
  await git(root, ["init", "--bare", "-b", "main", remote]);
  await git(source, ["remote", "add", "origin", remote]);
  await git(source, ["push", "origin", "main"]);
  const measurements: Record<string, number[]> = {
    picker: [],
    create: [],
    retry: [],
  };
  async function measure(
    name: string,
    operation: () => Promise<{ status: string }>,
  ) {
    const start = performance.now();
    const result = await operation();
    assert.notEqual(result.status, "failed", JSON.stringify(result));
    measurements[name]?.push(performance.now() - start);
  }
  for (let i = 0; i < 7; i++) {
    await measure("picker", () =>
      harness.experimental_call("inspect", { binaryPath, sourcePath: source }),
    );
    const input = {
      options: defaultProjectOptions,
      id: randomUUID(),
      name: `bench-${i}`,
      branchName: `bb/bench-${i}`,
      binaryPath,
      sourcePath: source,
    };
    await measure("create", () => createCopy(input, data, signal));
    await measure("retry", () => createCopy(input, data, signal));
  }
  console.log(
    JSON.stringify(
      {
        fixture: {
          trackedFiles: 1000,
          ignoredFiles: 4000,
          remote: "local bare Git",
          samples: 7,
        },
        milliseconds: Object.fromEntries(
          Object.entries(measurements).map(([key, values]) => [
            key,
            { median: [...values].sort((a, b) => a - b)[3], samples: values },
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await harness.experimental_dispose();
  await fs.rm(root, { recursive: true, force: true });
}
