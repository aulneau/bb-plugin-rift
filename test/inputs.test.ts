import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { riftInputsSchema, creationOptions } from "../inputs.js";
import { defaultProjectOptions } from "../options.js";
import { hostContract } from "../contract.js";

test("per-environment branch choices override the resolved default and reject Git expressions", () => {
  const defaults = {
    ...defaultProjectOptions,
    startingBranch: "origin/develop",
    reuseDependencies: false,
  };
  for (const empty of [undefined, {}])
    assert.deepEqual(
      creationOptions(defaults, riftInputsSchema.parse(empty)),
      defaults,
    );
  for (const name of [
    "main",
    "feature/local-work",
    "origin/release",
    "upstream/develop",
  ])
    assert.deepEqual(
      creationOptions(
        defaults,
        riftInputsSchema.parse({ branch: { kind: "named", name } }),
      ),
      { ...defaults, startingBranch: name },
    );
  for (const name of [
    "",
    "HEAD",
    "@",
    "--help",
    "main~1",
    "origin/a:b",
    "main^{commit}",
    "a..b",
    "a.lock",
    "refs/../main",
  ])
    assert.equal(
      riftInputsSchema.safeParse({ branch: { kind: "named", name } }).success,
      false,
      name,
    );
});

test("the provider forwards the selected branch and retains its receipt as the diff base", async () => {
  const seen: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "rift",
    experimental_callHostRpc: async ({ method, input }) => {
      assert.equal(method, "create");
      const parsed = hostContract.create.input.parse(input);
      seen.push(parsed.options.startingBranch);
      return {
        status: "created",
        copy: {
          id: parsed.id,
          name: parsed.name,
          sourcePath: parsed.sourcePath,
          path: "/fixture/copy",
          branch: parsed.branchName,
          startingBranch: parsed.options.startingBranch,
          startingCommit: "a".repeat(40),
          createdAt: 0,
        },
      };
    },
  });
  try {
    plugin(bb);
    await harness.behavior.setSettings({ startingBranch: "origin/develop" });
    const provider = harness.registrations.environmentProviders.get("rift");
    assert.ok(provider);
    for (const inputs of [
      riftInputsSchema.parse({}),
      riftInputsSchema.parse({
        branch: { kind: "named", name: "feature/local" },
      }),
    ]) {
      const result = await provider.create({
        project: {
          id: "proj_one",
          name: "Fixture",
          kind: "standard",
          gitRemoteUrl: null,
          createdAt: 0,
          updatedAt: 0,
        },
        host: { ...makeHostResponse({ id: "host_one" }), type: "persistent" },
        thread: makeThreadResponse({ id: "thr_one", projectId: "proj_one" }),
        projectCheckout: { path: "/fixture/source" },
        gitRemote: null,
        inputs,
        pathKey: "fixture",
        rebuild: false,
        suggestedBranchName: "bb/fixture",
        attempt: 1,
        previous: null,
        experimental_claimPath: async () => true,
        report: { step: () => {}, log: () => {} },
        signal: new AbortController().signal,
      });
      assert.equal(result.status, "created");
      if (result.status === "created")
        assert.equal(result.mergeBaseBranch, seen.at(-1));
    }
    assert.deepEqual(seen, ["origin/develop", "feature/local"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});
