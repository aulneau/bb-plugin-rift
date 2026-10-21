import os from "node:os";
import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract.js";
import { createCopy, removeCopy, type PrepareRuntime } from "./workspace.js";
import { inspectSource } from "./checkout.js";
import { createInspectionCache } from "./inspection-cache.js";
import { createRuntimeManager } from "./runtime.js";
import { standardRegistry } from "./platform.js";

export function makeHostEntry(runtimeFactory = createRuntimeManager) {
  let inspections: ReturnType<typeof createInspectionCache> | null = null;
  function inspectionCache(dataDir: string) {
    inspections ??= createInspectionCache(async (input, signal) => {
      const source = await inspectSource(input.sourcePath, signal);
      if (source.status === "failed") return source;
      const state = await runtimeFactory(dataDir).run(
        input.binaryPath,
        "status",
        signal,
      );
      return state.installation.status === "failed"
        ? state.installation
        : {
            status: "ready",
            platform: `${process.platform}-${process.arch}`,
          };
    });
    return inspections;
  }
  function prepare(dataDir: string): PrepareRuntime {
    return async (binaryPath, signal) => {
      const state = await runtimeFactory(dataDir).run(
        binaryPath,
        "ensure",
        signal,
      );
      return state.installation.status === "ready"
        ? state.installation
        : {
            status: "failed",
            message:
              state.updateError ??
              (state.installation.status === "failed"
                ? state.installation.message
                : "Rift could not be installed. Retry from Rift settings."),
          };
    };
  }
  return experimental_defineHostEntry({
    dispose: () => inspections?.dispose(),
    contract: hostContract,
    handlers: {
      runtime: async (input, context) => {
        const result = await runtimeFactory(
          context.experimental_paths.dataDir,
        ).run(input.binaryPath, input.action, context.signal);
        inspections?.invalidate();
        return result;
      },
      create: (input, context) =>
        createCopy(
          input,
          context.experimental_paths.dataDir,
          context.signal,
          [standardRegistry()],
          prepare(context.experimental_paths.dataDir),
        ),
      inspect: (input, context) =>
        inspectionCache(context.experimental_paths.dataDir).read(
          input,
          context.signal,
        ),
      remove: (input, context) =>
        removeCopy(
          input,
          context.experimental_paths.dataDir,
          context.signal,
          prepare(context.experimental_paths.dataDir),
        ),
    },
  });
}

export default makeHostEntry();
