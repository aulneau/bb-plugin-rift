import fs from "node:fs/promises";
import path from "node:path";
import { resolveExecutable } from "./executable.js";
import { exists } from "./filesystem.js";
import { isSupportedPlatform, currentPlatform, unsupportedMessage } from "./platform.js";
import { runCommand } from "./process.js";
const failed = (message: string) => ({ status: "failed" as const, message });
export async function inspectCheckout(
  binaryPath: string,
  sourcePath: string,
  signal: AbortSignal,
) {
  try {
    if (!isSupportedPlatform(currentPlatform())) return failed(unsupportedMessage);
    const executable = await resolveExecutable(binaryPath);
    if (executable.status === "failed") return executable;
    const capability = await runCommand(
      executable.binaryPath,
      ["create", "--help"],
      path.dirname(executable.binaryPath),
      signal,
    );
    if (capability.status === "failed") return capability;
    if (
      !capability.stdout.includes("--copy-all") ||
      !capability.stdout.includes("--no-hooks")
    )
      return failed(
        "Rift must support --copy-all and --no-hooks. Install rift-snapshot 0.0.10 or newer.",
      );
    const checkout = await inspectSource(sourcePath, signal);
    if (checkout.status === "failed") return checkout;
    return {
      status: "ready" as const,
      platform: `${process.platform}-${process.arch}`,
      binaryPath: executable.binaryPath,
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

export async function inspectSource(sourcePath: string, signal: AbortSignal) {
  try {
    if (!isSupportedPlatform(currentPlatform())) return failed(unsupportedMessage);
    const source = await fs.realpath(sourcePath);
    const gitStat = await fs.lstat(path.join(source, ".git"));
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
      return failed(
        "Rift cannot copy a linked Git worktree. Choose the project's original checkout.",
      );
    const root = await runCommand(
      "git",
      ["rev-parse", "--show-toplevel"],
      source,
      signal,
    );
    if (root.status === "failed" || (await fs.realpath(root.stdout)) !== source)
      return failed("External Git working-tree paths are unsupported.");
    const config = await runCommand(
      "git",
      [
        "config",
        "--null",
        "--get-regexp",
        "^(core\\.worktree|remote\\.origin\\.url)$",
      ],
      source,
      signal,
    );
    if (config.status === "failed")
      return failed(
        "Cannot read the checkout configuration. Configure an origin remote before using Rift. " +
          config.message,
      );
    const entries = config.stdout
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const separator = record.indexOf("\n");
        return {
          key: record.slice(0, separator),
          value: record.slice(separator + 1),
        };
      });
    if (entries.some((entry) => entry.key === "core.worktree"))
      return failed("A checkout with core.worktree configured is unsupported.");
    if (
      !entries.some(
        (entry) => entry.key === "remote.origin.url" && entry.value.length > 0,
      )
    )
      return failed("Configure an origin remote before using Rift.");
    for (const entry of ["commondir", "objects/info/alternates"]) {
      if (await exists(path.join(source, ".git", entry)))
        return failed("The checkout depends on external Git storage: " + entry);
    }
    if ((await fs.lstat(path.join(source, ".git", "objects"))).isSymbolicLink())
      return failed("Git objects must be stored inside the checkout.");
    return { status: "ready" as const };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
