import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract.js";

import { configureSettings } from "./settings.js";

const timeoutMs = 15 * 60 * 1000;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function copyId(pathKey: string) {
  const hash = createHash("sha256").update(pathKey).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export default function plugin(bb: BbPluginApi) {
  const settings = configureSettings(bb);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.experimental_environments.register({
    id: "rift",
    displayName: "Rift",
    description:
      "Create an independent copy. Rift installs automatically on first use.",
    icon: "Copy",
    requires: { gitCheckout: true },
    policy: { pathKeys: "per-attempt", retireGraceMs: null },
    async availability(context) {
      if (context.host === null || context.projectCheckout === null)
        return {
          status: "unavailable",
          message: "Choose a Mac with a project checkout.",
        };
      try {
        const binaryPath = await settings.executable(context.host.id);
        const result = await host.call(
          "inspect",
          { binaryPath, sourcePath: context.projectCheckout.path },
          { hostId: context.host.id, timeoutMs: 10000 },
        );
        return result.status === "ready"
          ? { status: "available" }
          : { status: "unavailable", message: result.message };
      } catch (error) {
        return { status: "unavailable", message: message(error) };
      }
    },
    async create(context) {
      if (context.rebuild)
        return {
          status: "failed",
          failure: "terminal",
          message:
            "This Rift environment is unavailable. Restore its retained copy before reusing it, or start a new Rift environment. Automatic rebuilding could lose its independent Git history.",
        };
      try {
        const { binaryPath, options } = await settings.resolve(
          context.project.id,
          context.host.id,
        );
        context.report.step(
          `Preparing Rift, ${options.fetchBeforeCreate ? "Fetching" : "Using cached"} ${options.startingBranch} and creating a Rift environment`,
        );
        const result = await host.call(
          "create",
          {
            id: copyId(context.pathKey),
            name: context.thread.id,
            sourcePath: context.projectCheckout.path,
            binaryPath,
            options,
            branchName: context.suggestedBranchName,
          },
          { hostId: context.host.id, signal: context.signal, timeoutMs },
        );
        if (result.status === "busy")
          return {
            status: "failed",
            failure: "transient",
            message: result.message,
          };
        if (result.status === "failed")
          return { ...result, failure: "terminal" };
        context.report.log(
          `Rift copy: ${result.copy.path}\nBranch: ${result.copy.branch}\nStarting point: ${result.copy.startingBranch} at ${result.copy.startingCommit}`,
        );
        return {
          status: "created",
          path: result.copy.path,
          ownsPath: true,
          mergeBaseBranch: result.copy.startingBranch,
          resource: result.copy,
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return {
          status: "failed",
          failure: "transient",
          message: message(error),
        };
      }
    },
    async remove(context) {
      if (context.hostId === null)
        return { status: "failed", message: "The Rift machine is unknown." };
      const binaryPath = await settings.executable(context.hostId);
      context.report.step(
        "Retaining the Rift snapshot before removing its environment",
      );
      try {
        const result = await host.call(
          "remove",
          { id: copyId(context.pathKey), binaryPath },
          { hostId: context.hostId, signal: context.signal, timeoutMs },
        );
        if (result.status === "failed") return result;
        if (result.retainedPath !== null)
          context.report.log(
            `Snapshot retained at ${result.retainedPath}. No Rift garbage collection was run.`,
          );
        return { status: "removed" };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: message(error) };
      }
    },
  });
}
