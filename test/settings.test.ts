import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { configureSettings } from "../settings.js";
import { defaultProjectOptions, startingBranchSchema } from "../options.js";
import { settingsContract } from "../settings-contract.js";

function fixture() {
  return createFakePluginHost({
    pluginId: "rift",
    sdk: {
      projects: {
        get: async ({ projectId }) => ({
          id: projectId,
          name: "Fixture",
          kind: "standard",
          gitRemoteUrl: null,
          createdAt: 0,
          updatedAt: 0,
          sources: [],
        }),
      },
      hosts: {
        get: async ({ hostId }) => ({
          id: hostId,
          name: "Fixture Mac",
          createdAt: 0,
          updatedAt: 0,
          lastSeenAt: null,
          lastRejectedProtocolVersion: null,
          machineProviderId: null,
          maxPermissionMode: "auto",
          status: "connected",
          type: "persistent",
          lifecycle: {
            phase: "active",
            message: null,
            pendingLog: "",
            suspendedAt: null,
            teardown: null,
          },
          connectMachineId: null,
        }),
      },
    },
  });
}

test("project and machine overrides remain scoped across defaults, CLI, RPC and reload", async () => {
  let { bb, harness } = fixture();
  let settings = configureSettings(bb);
  try {
    assert.deepEqual(await settings.resolve("proj_one", "host_one"), {
      options: defaultProjectOptions,
      binaryPath: "",
    });
    await harness.behavior.setSettings({
      binaryPath: "/default/rift",
      startingBranch: "origin/develop",
    });
    const custom = {
      fetchBeforeCreate: false,
      startingBranch: "origin/release/next",
      reuseDependencies: false,
    };
    assert.equal(
      (
        await harness.behavior.runCli([
          "project",
          "proj_one",
          "set",
          JSON.stringify(custom),
        ])
      ).exitCode,
      0,
    );
    const saved = await harness.behavior.callRpc("saveMachineExecutable", {
      hostId: "host_one",
      value: "",
    });
    assert.equal(
      settingsContract.saveMachineExecutable.output.parse(saved).effective,
      "",
    );
    assert.deepEqual(await settings.resolve("proj_one", "host_one"), {
      options: custom,
      binaryPath: "",
    });
    assert.deepEqual(await settings.resolve("proj_two", "host_two"), {
      options: { ...defaultProjectOptions, startingBranch: "origin/develop" },
      binaryPath: "/default/rift",
    });
    ({ bb, harness } = await harness.lifecycle.reload((next) => {
      settings = configureSettings(next);
    }));
    assert.deepEqual(await settings.resolve("proj_one", "host_one"), {
      options: custom,
      binaryPath: "",
    });
    assert.equal(
      (await harness.behavior.runCli(["project", "proj_one", "reset"]))
        .exitCode,
      0,
    );
    assert.equal(
      (await harness.behavior.runCli(["machine", "host_one", "reset"]))
        .exitCode,
      0,
    );
    assert.deepEqual(await settings.resolve("proj_one", "host_one"), {
      options: { ...defaultProjectOptions, startingBranch: "origin/develop" },
      binaryPath: "/default/rift",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("invalid settings are rejected consistently and leave stored configuration unchanged", async () => {
  const { bb, harness } = fixture();
  const settings = configureSettings(bb);
  try {
    for (const branch of [
      "main",
      "--upload-pack=bad",
      "origin/../main",
      "origin/a..b",
      "origin/main:other",
      "origin/a.lock",
      "origin/a b",
      "origin/a//b",
      "origin/.hidden",
    ])
      assert.equal(
        startingBranchSchema.safeParse(branch).success,
        false,
        branch,
      );
    assert.equal(
      startingBranchSchema.safeParse("origin/release/next").success,
      true,
    );
    await assert.rejects(
      harness.behavior.setSettings({ startingBranch: "origin/bad:ref" }),
    );
    await assert.rejects(
      harness.behavior.callRpc("saveProjectOptions", {
        projectId: "proj_one",
        value: { ...defaultProjectOptions, reuseDependencies: "false" },
      }),
    );
    assert.equal(
      (
        await harness.behavior.runCli([
          "machine",
          "host_one",
          "set",
          "relative/rift",
        ])
      ).exitCode,
      1,
    );
    assert.equal(
      (
        await harness.behavior.runCli([
          "project",
          "proj_one",
          "reset",
          "ignored",
        ])
      ).exitCode,
      1,
    );
    assert.deepEqual(await settings.resolve("proj_one", "host_one"), {
      options: defaultProjectOptions,
      binaryPath: "",
    });
    const result = await harness.behavior.callRpc("projectOptions", {
      projectId: "proj_one",
    });
    assert.deepEqual(
      settingsContract.projectOptions.output.parse(result).effective,
      defaultProjectOptions,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("runtime UI RPC and CLI target the selected machine and updates honor its executable override", async () => {
  const calls: Array<{ hostId: string; input: unknown }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "rift",
    experimental_callHostRpc: async ({ hostId, input }) => {
      calls.push({ hostId, input });
      return {
        installation: { status: "missing" },
        latestVersion: null,
        checkedAt: null,
        updateError: null,
      };
    },
    sdk: {
      hosts: {
        get: async () => {
          throw new Error("unconfigured host");
        },
        list: async () => [],
      },
    },
  });
  const hostFixture = fixture();
  try {
    const host = await hostFixture.bb.sdk.hosts.get({ hostId: "host_one" });
    harness.inspection.sdk.stub("hosts.get", async ({ hostId }) => ({
      ...host,
      id: hostId,
    }));
    configureSettings(bb);
    await harness.behavior.callRpc("saveMachineExecutable", {
      hostId: "host_one",
      value: "/custom/rift",
    });
    await harness.behavior.callRpc("runtime", {
      hostId: "host_one",
      action: "update",
    });
    const result = await harness.behavior.runCli([
      "runtime",
      "host_two",
      "install",
    ]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, [
      {
        hostId: "host_one",
        input: { binaryPath: "/custom/rift", action: "update" },
      },
      { hostId: "host_two", input: { binaryPath: "", action: "install" } },
    ]);
    assert.equal(
      (await harness.behavior.runCli(["runtime", "host_two", "invalid"]))
        .exitCode,
      1,
    );
    await harness.behavior.runSchedule("rift-updates");
    assert.equal(calls.length, 2);
  } finally {
    await harness.lifecycle.dispose();
    await hostFixture.harness.lifecycle.dispose();
  }
});
