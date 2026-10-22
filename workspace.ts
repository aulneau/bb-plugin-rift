import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  copySchema,
  hostContract,
  pathSchema,
  type RiftCopy,
} from "./contract.js";
import { runCommand } from "./process.js";
import { exists, writeJson } from "./filesystem.js";
import { inspectCheckout, inspectSource } from "./checkout.js";
import { removeDependencies } from "./dependencies.js";
import { defaultProjectOptions, copyOptionsSchema } from "./options.js";
import { resolveExecutable } from "./executable.js";
import { resolveStartingPoint } from "./starting-point.js";
import { withFileLock } from "./file-lock.js";
import { runHostSetup } from "./host-setup.js";

export type PrepareRuntime = (
  binaryPath: string,
  signal: AbortSignal,
) => Promise<
  | { status: "ready"; binaryPath: string }
  | { status: "failed"; message: string }
>;

type CopyInput = z.infer<typeof hostContract.create.input>;
export type CopyResult =
  | { status: "created"; copy: RiftCopy }
  | { status: "failed"; message: string }
  | { status: "busy"; message: string };
const failed = (message: string) => ({ status: "failed" as const, message });
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const planSchema = z
  .object({
    input: hostContract.create.input.extend({
      options: copyOptionsSchema.default(defaultProjectOptions),
    }),
    target: pathSchema,
    source: pathSchema,
    database: pathSchema,
    retainedPath: pathSchema.nullable(),
  })
  .strict();
type Plan = z.infer<typeof planSchema>;
const storedCopySchema = z.union([
  copySchema,
  copySchema
    .omit({ startingBranch: true, startingCommit: true })
    .extend({ mainCommit: z.string().regex(/^[a-f0-9]{40,64}$/) })
    .strict()
    .transform(({ mainCommit, ...copy }) => ({
      ...copy,
      startingBranch: "origin/main",
      startingCommit: mainCommit,
    })),
]);

export async function createCopy(
  input: CopyInput,
  dataDir: string,
  signal: AbortSignal,
  existingDatabases: readonly string[] = [],
  prepareRuntime: PrepareRuntime = (binaryPath) =>
    resolveExecutable(binaryPath),
): Promise<CopyResult> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    return await withFileLock(
      path.join(dataDir, `copy-${input.id}.lock`),
      signal,
      async (): Promise<CopyResult> => {
        const existingPlanFile = path.join(
          dataDir,
          "copies",
          `${input.id}.plan.json`,
        );
        const previousPlan = (await exists(existingPlanFile))
          ? planSchema.parse(
              JSON.parse(await fs.readFile(existingPlanFile, "utf8")),
            )
          : null;
        if (
          previousPlan !== null &&
          (previousPlan.input.id !== input.id ||
            previousPlan.input.name !== input.name ||
            previousPlan.input.sourcePath !== input.sourcePath ||
            previousPlan.input.branchName !== input.branchName)
        )
          return failed("This copy ID belongs to a different operation.");
        const source =
          previousPlan?.source ?? (await fs.realpath(input.sourcePath));
        const receipt = path.join(dataDir, "copies", `${input.id}.json`);
        if (await exists(receipt)) {
          const copy = storedCopySchema.parse(
            JSON.parse(await fs.readFile(receipt, "utf8")),
          );
          if (
            copy.id !== input.id ||
            copy.sourcePath !== source ||
            copy.name !== input.name ||
            copy.branch !== input.branchName
          )
            return failed("This copy ID belongs to a different operation.");
          if (previousPlan !== null && previousPlan.retainedPath !== null)
            return failed(
              "This environment was removed; snapshot retained at " +
                previousPlan.retainedPath,
            );
          if (!(await exists(copy.path)))
            return failed("This copy was moved or removed: " + copy.path);
          return { status: "created", copy };
        }
        const key = createHash("sha256").update(source).digest("hex");
        // The source's own lock, shared with anything else that changes the checkout (a machine's
        // scheduled refresh of a base): copies wait for it, up to 20 minutes.
        const base = await withFileLock(
          path.join(source, ".git", "base.lock"),
          signal,
          () => withFileLock(path.join(dataDir, `${key}.lock`), signal, () =>
          createLockedCopy(
            input,
            dataDir,
            source,
            signal,
            existingDatabases,
            prepareRuntime,
          ),
          ),
          20 * 60_000,
        );
        return base;
      },
    );
  } catch (error) {
    return failed(errorMessage(error));
  }
}

async function createLockedCopy(
  input: CopyInput,
  dataDir: string,
  source: string,
  signal: AbortSignal,
  existingDatabases: readonly string[],
  prepareRuntime: PrepareRuntime,
): Promise<CopyResult> {
  const key = createHash("sha256").update(source).digest("hex");
  const recordsDir = path.join(dataDir, "copies");
  await fs.mkdir(recordsDir, { recursive: true });
  const receipt = path.join(recordsDir, `${input.id}.json`);

  const checkout = await inspectSource(source, signal);
  if (checkout.status === "failed") return checkout;
  const runtime = await prepareRuntime(input.binaryPath, signal);
  if (runtime.status === "failed") return runtime;
  const capability = await inspectCheckout(runtime.binaryPath, source, signal);
  if (capability.status === "failed") return capability;
  const binaryPath = capability.binaryPath;
  const { startingBranch, fetchBeforeCreate, reuseDependencies } =
    input.options;
  const destination = path.join(
    path.dirname(source),
    ".bb-rifts",
    `${path.basename(source)}-${key.slice(0, 8)}`,
  );
  await fs.mkdir(destination, { recursive: true });
  const targetParent = await fs.realpath(destination);
  if (targetParent === source || targetParent.startsWith(source + path.sep))
    return failed("Rift copies must be outside their source checkout.");
  if ((await fs.stat(source)).dev !== (await fs.stat(targetParent)).dev)
    return failed("Source and destination must be on the same copy-on-write filesystem (APFS, XFS or btrfs).");
  const target = path.join(targetParent, `${input.name}-${input.id}`);
  const planFile = path.join(recordsDir, `${input.id}.plan.json`);
  if (await exists(planFile))
    return failed(
      "An interrupted creation is retained at " +
        target +
        ". Remove its failed BB environment before starting a new one.",
    );
  if (await exists(target))
    return failed("Destination already exists: " + target);
  let database = path.join(dataDir, `${key}.sqlite`);
  const marker = path.join(source, ".rift");
  if (await exists(marker)) {
    let matched = false;
    for (const candidate of [database, ...existingDatabases]) {
      if (!(await exists(candidate))) continue;
      const known = await runCommand(
        binaryPath,
        ["--database", candidate, "list", source],
        source,
        signal,
      );
      if (known.status === "ok") {
        database = candidate;
        matched = true;
        break;
      }
      if (signal.aborted) return failed("Registry lookup cancelled.");
    }
    if (!matched)
      return failed(
        "The checkout has a Rift marker, but its registry could not be found in BB or the standard Rift data directory. Its ownership was left unchanged.",
      );
  } else {
    const initialized = await runCommand(
      binaryPath,
      ["--database", database, "init", source, "--here"],
      source,
      signal,
    );
    if (initialized.status === "failed") return initialized;
  }
  const head = await resolveStartingPoint(
    source,
    startingBranch,
    fetchBeforeCreate,
    signal,
  );
  if (head.status === "failed") return head;
  const plan: Plan = {
    input,
    target,
    source,
    database,
    retainedPath: null,
  };
  await writeJson(planFile, plan);
  const copied = await runCommand(
    binaryPath,
    [
      "--database",
      database,
      "create",
      source,
      "--into",
      targetParent,
      "--name",
      path.basename(target),
      "--copy-all",
      "--no-hooks",
    ],
    source,
    signal,
  );
  if (copied.status === "failed")
    return failed(
      `${copied.message}\nAny partial copy is retained at ${target}.`,
    );
  if (copied.stdout !== target)
    return failed(
      "Rift returned an unexpected destination. Expected " + target,
    );
  if (signal.aborted) return failed("Copy cancelled; retained at " + target);
  const targetGit = path.join(target, ".git");
  const gitStat = await fs.lstat(targetGit);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
    return failed(
      "Copied Git storage is not independent; retained at " + target,
    );
  await fs.rm(path.join(targetGit, "worktrees"), {
    recursive: true,
    force: true,
  });
  for (const args of [
    ["checkout", "--force", "--no-track", "-b", input.branchName, head.commit],
    ["clean", "-fd"],
  ]) {
    const result = await runCommand(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      target,
      signal,
    );
    if (result.status === "failed")
      return failed(`${result.message}\nCopy retained at ${target}.`);
  }
  if (!reuseDependencies) {
    const cleaned = await removeDependencies(target, signal);
    if (cleaned.status === "failed")
      return failed(`${cleaned.message}\nCopy retained at ${target}.`);
  }
  const setup = await runHostSetup(source, target, signal);
  if (setup.status === "failed")
    return failed(`${setup.message}\nCopy retained at ${target}.`);
  const copy: RiftCopy = {
    id: input.id,
    name: input.name,
    sourcePath: source,
    path: target,
    branch: input.branchName,
    startingBranch,
    startingCommit: head.commit,
    createdAt: Date.now(),
  };
  await writeJson(receipt, copy);
  return { status: "created", copy };
}

export async function removeCopy(
  input: z.infer<typeof hostContract.remove.input>,
  dataDir: string,
  signal: AbortSignal,
  prepareRuntime: PrepareRuntime = (binaryPath) =>
    resolveExecutable(binaryPath),
): Promise<z.infer<typeof hostContract.remove.output>> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const result = await withFileLock(
      path.join(dataDir, `copy-${input.id}.lock`),
      signal,
      async () => {
        const planFile = path.join(dataDir, "copies", `${input.id}.plan.json`);
        if (!(await exists(planFile)))
          return { status: "removed" as const, retainedPath: null };
        const plan = planSchema.parse(
          JSON.parse(await fs.readFile(planFile, "utf8")),
        );
        if (plan.input.id !== input.id)
          return failed(
            "Rift removal receipt does not match this environment.",
          );
        const key = createHash("sha256").update(plan.source).digest("hex");
        return withFileLock(path.join(dataDir, `${key}.lock`), signal, () =>
          removeLockedCopy(
            input.binaryPath,
            plan,
            planFile,
            signal,
            prepareRuntime,
          ),
        );
      },
    );
    return result.status === "busy" ? failed(result.message) : result;
  } catch (error) {
    return failed(errorMessage(error));
  }
}

async function removeLockedCopy(
  binaryPath: string,
  plan: Plan,
  planFile: string,
  signal: AbortSignal,
  prepareRuntime: PrepareRuntime,
): Promise<z.infer<typeof hostContract.remove.output>> {
  if (!(await exists(plan.target))) {
    if (plan.retainedPath !== null && !(await exists(plan.retainedPath)))
      return failed(
        "The retained snapshot was moved or deleted: " + plan.retainedPath,
      );
    return { status: "removed", retainedPath: plan.retainedPath };
  }
  if (signal.aborted) return failed("Removal cancelled.");
  const markerPath = path.join(plan.target, ".rift");
  if (!(await exists(markerPath))) {
    const retainedPath = path.join(
      path.dirname(plan.target),
      ".retained",
      path.basename(plan.target),
    );
    await fs.mkdir(path.dirname(retainedPath), { recursive: true });
    if (await exists(retainedPath))
      return failed(
        "A retained partial copy already exists at " + retainedPath,
      );
    await writeJson(planFile, { ...plan, retainedPath });
    await fs.rename(plan.target, retainedPath);
    return { status: "removed", retainedPath };
  }
  const executable = await prepareRuntime(binaryPath, signal);
  if (executable.status === "failed") return executable;
  binaryPath = executable.binaryPath;
  const descendants = await runCommand(
    binaryPath,
    ["--database", plan.database, "list", plan.target],
    path.dirname(plan.target),
    signal,
  );
  if (descendants.status === "failed") return descendants;
  if (descendants.stdout !== "")
    return failed(
      "This Rift has child copies. Remove or relocate them before removing their parent.",
    );
  const marker = (await fs.readFile(markerPath, "utf8")).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(marker))
    return failed(
      "The Rift marker has an unexpected format; the copy was retained.",
    );
  const retainedPath = path.join(
    path.dirname(plan.target),
    ".trash",
    `${marker}-${path.basename(plan.target)}`,
  );
  await writeJson(planFile, { ...plan, retainedPath });
  const help = await runCommand(
    binaryPath,
    ["remove", "--help"],
    path.dirname(plan.target),
    signal,
  );
  if (help.status === "failed") return help;
  const remove = await runCommand(
    binaryPath,
    [
      "--database",
      plan.database,
      "remove",
      plan.target,
      ...(help.stdout.includes("--no-hooks") ? ["--no-hooks"] : []),
    ],
    path.dirname(plan.target),
    signal,
  );
  if (remove.status === "failed") return remove;
  if ((await exists(plan.target)) || !(await exists(retainedPath)))
    return failed(
      "Rift removal did not produce the expected retained snapshot at " +
        retainedPath,
    );
  return { status: "removed", retainedPath };
}
