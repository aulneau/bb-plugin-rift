import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  executableSchema,
  projectOptionsSchema,
  startingBranchSchema,
  type ProjectOptions,
} from "./options.js";
import { hostContract } from "./contract.js";
import { runtimeActionSchema, type RuntimeAction } from "./runtime-contract.js";
import { settingsContract } from "./settings-contract.js";

export function configureSettings(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const defaults = bb.settings.define({
    fetchBeforeCreate: {
      type: "boolean",
      label: "Fetch before creating",
      default: true,
      description:
        "Fetch the starting branch before each new environment. Turn off to use its last-fetched commit offline. Fetch failures stop creation.",
    },
    startingBranch: {
      type: "string",
      label: "Starting branch",
      default: "origin/main",
      experimental_schema: startingBranchSchema,
      description:
        "Remote branch for new environments, such as origin/main or origin/develop.",
    },
    reuseDependencies: {
      type: "boolean",
      label: "Reuse dependencies and build caches",
      default: true,
      description:
        "Turn off to clean ignored generated directories in the new copy before BB setup. Tracked files and local configuration outside those directories are kept.",
    },
    binaryPath: {
      type: "string",
      label: "Rift executable override",
      default: "",
      experimental_schema: executableSchema,
      description:
        "Leave empty for automatic installation and updates on each Mac. An explicit path is user-managed and will never be updated by BB.",
    },
  });
  async function projectOptions(projectId: string) {
    const { binaryPath: _binaryPath, ...fallback } = await defaults.get();
    const saved = await bb.storage.kv.get<unknown>(
      `project-options:${projectId}`,
    );
    const override =
      saved === undefined ? null : projectOptionsSchema.parse(saved);
    return { effective: override ?? fallback, override };
  }
  async function machineExecutable(hostId: string) {
    const saved = await bb.storage.kv.get<unknown>(
      `machine-executable:${hostId}`,
    );
    const override = saved === undefined ? null : executableSchema.parse(saved);
    return {
      effective: override ?? (await defaults.get()).binaryPath,
      override,
    };
  }
  async function saveProjectOptions(
    projectId: string,
    value: ProjectOptions | null,
  ) {
    await bb.sdk.projects.get({ projectId });
    if (value === null)
      await bb.storage.kv.delete(`project-options:${projectId}`);
    else await bb.storage.kv.set(`project-options:${projectId}`, value);
    return projectOptions(projectId);
  }
  async function saveMachineExecutable(hostId: string, value: string | null) {
    await bb.sdk.hosts.get({ hostId });
    if (value === null)
      await bb.storage.kv.delete(`machine-executable:${hostId}`);
    else await bb.storage.kv.set(`machine-executable:${hostId}`, value);
    return machineExecutable(hostId);
  }
  async function runtime(hostId: string, action: RuntimeAction) {
    await bb.sdk.hosts.get({ hostId });
    return host.call(
      "runtime",
      { binaryPath: (await machineExecutable(hostId)).effective, action },
      { hostId, timeoutMs: 150_000 },
    );
  }
  bb.rpc.register(settingsContract, {
    runtime: ({ hostId, action }) => runtime(hostId, action),
    choices: async () => {
      const [projects, machines] = await Promise.all([
        bb.sdk.projects.list(),
        bb.sdk.hosts.list(),
      ]);
      return {
        projects: projects.map(({ id, name }) => ({ id, name })),
        machines: machines.map(({ id, name }) => ({ id, name })),
      };
    },
    projectOptions: ({ projectId }) => projectOptions(projectId),
    machineExecutable: ({ hostId }) => machineExecutable(hostId),
    saveProjectOptions: ({ projectId, value }) =>
      saveProjectOptions(projectId, value),
    saveMachineExecutable: ({ hostId, value }) =>
      saveMachineExecutable(hostId, value),
  });
  const usage =
    "bb rift runtime <machine-id> [status | check | install | update]\nbb rift project <project-id> [set <json> | reset]\nbb rift machine <machine-id> [set <absolute-path-or-empty-string> | reset]";
  bb.cli.register({
    name: "rift",
    summary: "Manage Rift installations and environment settings",
    commands: [
      {
        name: "runtime",
        summary: "Inspect, install or update Rift on a machine",
        usage:
          "bb rift runtime <machine-id> [status | check | install | update]",
      },
      {
        name: "project",
        summary: "Read, replace or reset a project's creation options",
        usage: "bb rift project <project-id> [set <json> | reset]",
      },
      {
        name: "machine",
        summary: "Read, replace or reset a machine's executable override",
        usage: "bb rift machine <machine-id> [set <path> | reset]",
      },
    ],
    async run(argv) {
      if (argv.length === 0 || argv[0] === "--help")
        return { exitCode: 0, stdout: usage };
      const [scope, id, action, raw] = argv;
      if (scope === "runtime") {
        try {
          if (id === undefined || argv.length > 3)
            return { exitCode: 1, stderr: usage };
          const parsed = settingsContract.runtime.input.parse({
            hostId: id,
            action: runtimeActionSchema.parse(action ?? "status"),
          });
          const result = await runtime(parsed.hostId, parsed.action);
          return {
            exitCode:
              result.updateError !== null ||
              result.installation.status === "failed"
                ? 1
                : 0,
            stdout: JSON.stringify(result, null, 2),
          };
        } catch (error) {
          return {
            exitCode: 1,
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (
        id === undefined ||
        (argv.length !== 2 &&
          !(action === "reset" && argv.length === 3) &&
          !(action === "set" && argv.length === 4))
      )
        return { exitCode: 1, stderr: usage };
      try {
        let result;
        if (scope === "project") {
          const input = settingsContract.projectOptions.input.parse({
            projectId: id,
          });
          result =
            action === undefined
              ? await projectOptions(input.projectId)
              : await saveProjectOptions(
                  input.projectId,
                  action === "reset"
                    ? null
                    : projectOptionsSchema.parse(JSON.parse(raw ?? "")),
                );
        } else if (scope === "machine") {
          const input = settingsContract.machineExecutable.input.parse({
            hostId: id,
          });
          result =
            action === undefined
              ? await machineExecutable(input.hostId)
              : await saveMachineExecutable(
                  input.hostId,
                  action === "reset" ? null : executableSchema.parse(raw),
                );
        } else return { exitCode: 1, stderr: usage };
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
  bb.background.schedule("rift-updates", "17 * * * *", async () => {
    const hosts = await bb.sdk.hosts.list();
    for (const machine of hosts) {
      if (machine.status !== "connected") continue;
      try {
        const result = await runtime(machine.id, "maintain");
        if (result.updateError !== null)
          bb.log.warn(`Rift update on ${machine.name}: ${result.updateError}`);
      } catch (error) {
        bb.log.warn(
          `Rift update on ${machine.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });
  return {
    async resolve(projectId: string, hostId: string) {
      const [project, machine] = await Promise.all([
        projectOptions(projectId),
        machineExecutable(hostId),
      ]);
      return { options: project.effective, binaryPath: machine.effective };
    },
    async executable(hostId: string) {
      return (await machineExecutable(hostId)).effective;
    },
  };
}
