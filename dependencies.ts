import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./process.js";

const generatedDirectories = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
export async function removeDependencies(
  checkout: string,
  signal: AbortSignal,
) {
  const ignored = await runCommand(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ],
    checkout,
    signal,
  );
  if (ignored.status === "failed") return ignored;
  const candidates = new Set<string>();
  for (const entry of ignored.stdout.split("\0")) {
    const parts = entry.split("/");
    const index = parts.findIndex((part) => generatedDirectories.has(part));
    if (index !== -1) candidates.add(parts.slice(0, index + 1).join("/"));
  }
  const targets: string[] = [];
  for (const candidate of candidates) {
    signal.throwIfAborted();
    const stat = await fs.lstat(path.join(checkout, candidate));
    if (stat.isDirectory() || stat.isSymbolicLink())
      targets.push(`:(literal)${candidate}`);
  }
  if (targets.length === 0) return { status: "ok" as const, stdout: "" };
  return runCommand(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "clean",
      "-fdX",
      "--quiet",
      "--",
      ...targets,
    ],
    checkout,
    signal,
  );
}
