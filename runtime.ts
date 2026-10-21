import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveExecutable } from "./executable.js";
import { runCommand } from "./process.js";
import { exists, writeJson } from "./filesystem.js";
import { withRuntimeLock } from "./runtime-lock.js";
import {
  downloadRelease,
  latestRelease,
  releaseSchema,
  versionSchema,
  type Release,
} from "./runtime-download.js";
import type {
  RuntimeAction,
  RuntimeInstallation,
  RuntimeState,
} from "./runtime-contract.js";

import { newerVersion } from "./runtime-version.js";
import { isSupportedPlatform, unsupportedMessage } from "./platform.js";

const day = 24 * 60 * 60 * 1000;
const stateSchema = z
  .object({
    active: z
      .object({
        directory: z.string().regex(/^v\d+\.\d+\.\d+-[a-zA-Z0-9_-]+$/),
        version: versionSchema,
      })
      .strict()
      .nullable(),
    release: releaseSchema.nullable(),
    checkedAt: z.number().nullable(),
    attemptedAt: z.number().nullable(),
    error: z.string().nullable(),
  })
  .strict();
type SavedState = z.infer<typeof stateSchema>;
const emptyState: SavedState = {
  active: null,
  release: null,
  checkedAt: null,
  attemptedAt: null,
  error: null,
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const failed = (error: unknown): RuntimeInstallation => ({
  status: "failed",
  message: message(error),
});

export async function probeRuntime(
  binaryPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runCommand(
    binaryPath,
    ["create", "--help"],
    path.dirname(binaryPath),
    AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  );
  if (result.status === "failed") return result.message;
  return result.stdout.includes("--copy-all") &&
    result.stdout.includes("--no-hooks")
    ? null
    : "Rift must support --copy-all and --no-hooks (rift-snapshot 0.0.10 or newer).";
}

async function existingVersion(binaryPath: string) {
  let directory = path.dirname(await fs.realpath(binaryPath));
  for (let depth = 0; depth < 4; depth++) {
    try {
      const data = z
        .object({ name: z.literal("rift-snapshot"), version: versionSchema })
        .safeParse(
          JSON.parse(
            await fs.readFile(path.join(directory, "package.json"), "utf8"),
          ),
        );
      if (data.success) return data.data.version;
    } catch {}
    directory = path.dirname(directory);
  }
  return null;
}

export function createRuntimeManager(
  dataDir: string,
  dependencies: {
    latest: (signal: AbortSignal) => Promise<Release>;
    download: (
      release: Release,
      platform: string,
      directory: string,
      signal: AbortSignal,
    ) => Promise<void>;
    discover: typeof resolveExecutable;
    probe: typeof probeRuntime;
    now: () => number;
    platform: string;
  } = {
    latest: latestRelease,
    download: downloadRelease,
    discover: resolveExecutable,
    probe: probeRuntime,
    now: Date.now,
    platform: `${process.platform}-${process.arch}`,
  },
) {
  const root = path.join(dataDir, "runtime");
  const stateFile = path.join(root, "state.json");
  async function read(): Promise<SavedState> {
    return (await exists(stateFile))
      ? stateSchema.parse(JSON.parse(await fs.readFile(stateFile, "utf8")))
      : { ...emptyState };
  }
  async function installation(
    override: string,
    saved: SavedState,
    signal: AbortSignal,
  ): Promise<RuntimeInstallation> {
    if (!isSupportedPlatform(dependencies.platform))
      return failed(unsupportedMessage);
    if (override === "" && saved.active !== null) {
      const binaryPath = path.join(root, saved.active.directory, "rift");
      const resolved = await dependencies.discover(binaryPath);
      if (resolved.status === "ready") {
        const error = await dependencies.probe(binaryPath, signal);
        if (error === null)
          return {
            status: "ready",
            source: "managed",
            binaryPath,
            version: saved.active.version,
          };
      }
    }
    const resolved = await dependencies.discover(override);
    if (resolved.status === "failed")
      return override === "" ? { status: "missing" } : resolved;
    const error = await dependencies.probe(resolved.binaryPath, signal);
    if (error !== null)
      return override === "" ? { status: "missing" } : failed(error);
    return {
      status: "ready",
      source: override === "" ? "existing" : "override",
      binaryPath: resolved.binaryPath,
      version: await existingVersion(resolved.binaryPath),
    };
  }
  function view(saved: SavedState, current: RuntimeInstallation): RuntimeState {
    return {
      installation: current,
      latestVersion: saved.release?.version ?? null,
      checkedAt: saved.checkedAt,
      updateError: saved.error,
    };
  }
  async function run(
    override: string,
    action: RuntimeAction | "ensure",
    signal: AbortSignal,
    caller: AbortSignal,
  ): Promise<RuntimeState> {
    const saved = await read();
    const current = await installation(override, saved, signal);
    if (override !== "") {
      const state = view({ ...emptyState }, current);
      return action === "install" || action === "update"
        ? {
            ...state,
            updateError:
              "Clear the executable override to let BB manage Rift. The configured executable was left unchanged.",
          }
        : state;
    }
    if (current.status === "failed" || action === "status")
      return view(saved, current);
    if (
      action === "maintain" &&
      (saved.attemptedAt === null ||
        dependencies.now() - saved.attemptedAt < day)
    )
      return view(saved, current);
    const automatic = action === "ensure" || action === "maintain";
    if (
      automatic &&
      saved.attemptedAt !== null &&
      dependencies.now() - saved.attemptedAt < day &&
      current.status === "ready"
    )
      return view(saved, current);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const result = await withRuntimeLock(root, signal, async () => {
      let next = await read();
      const selected = await installation(override, next, signal);
      if (
        automatic &&
        next.attemptedAt !== null &&
        dependencies.now() - next.attemptedAt < day &&
        selected.status === "ready"
      )
        return view(next, selected);
      try {
        signal.throwIfAborted();
        const cached = next.release;
        if (
          action === "check" ||
          action === "update" ||
          cached === null ||
          next.checkedAt === null ||
          dependencies.now() - next.checkedAt >= day
        ) {
          const release = releaseSchema.parse(
            await dependencies.latest(signal),
          );
          next = {
            ...next,
            release,
            checkedAt: dependencies.now(),
            error: null,
          };
        }
        if (action === "check") {
          await writeJson(stateFile, next);
          return view(next, selected);
        }
        next = { ...next, attemptedAt: dependencies.now() };
        await writeJson(stateFile, next);
        const release = next.release;
        if (release === null)
          throw new Error("Rift release information is unavailable.");
        if (
          selected.status === "ready" &&
          selected.source === "managed" &&
          selected.version !== null &&
          !newerVersion(release.version, selected.version)
        ) {
          next = { ...next, error: null };
          await writeJson(stateFile, next);
          return view(next, selected);
        }
        const staging = await fs.mkdtemp(path.join(root, ".install-"));
        try {
          await dependencies.download(
            release,
            dependencies.platform,
            staging,
            signal,
          );
          const binary = path.join(staging, "rift");
          if (!(await fs.lstat(binary)).isFile())
            throw new Error(
              "Downloaded Rift executable is not a regular file.",
            );
          const error = await dependencies.probe(binary, signal);
          if (error !== null) throw new Error(error);
          signal.throwIfAborted();
          const directory = `v${release.version}-${path.basename(staging).slice(".install-".length)}`;
          await fs.rename(staging, path.join(root, directory));
          const activated: SavedState = {
            ...next,
            active: { directory, version: release.version },
            error: null,
          };
          await writeJson(stateFile, activated);
          next = activated;
          return view(next, {
            status: "ready",
            source: "managed",
            binaryPath: path.join(root, directory, "rift"),
            version: release.version,
          });
        } finally {
          await fs.rm(staging, { recursive: true, force: true });
        }
      } catch (error) {
        caller.throwIfAborted();
        next = {
          ...next,
          attemptedAt: dependencies.now(),
          error: message(error),
        };
        await writeJson(stateFile, next);
        return view(next, selected);
      }
    });
    return result;
  }
  return {
    async run(
      override: string,
      action: RuntimeAction | "ensure",
      signal: AbortSignal,
    ): Promise<RuntimeState> {
      try {
        return await run(
          override,
          action,
          AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        return {
          installation: failed(error),
          latestVersion: null,
          checkedAt: null,
          updateError: null,
        };
      }
    },
  };
}
