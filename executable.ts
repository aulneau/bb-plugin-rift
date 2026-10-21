import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export async function resolveExecutable(
  override: string,
  searchPath: string = process.env.PATH ?? "",
  home: string = os.homedir(),
) {
  const candidates =
    override !== ""
      ? [override]
      : [
          ...new Set([
            ...searchPath
              .split(path.delimiter)
              .filter((entry) => path.isAbsolute(entry)),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            path.join(home, ".cargo/bin"),
            path.join(home, ".local/bin"),
            path.join(home, ".bun/bin"),
          ]),
        ].map((directory) => path.join(directory, "rift"));
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, constants.X_OK);
      return { status: "ready" as const, binaryPath: candidate };
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
  return {
    status: "failed" as const,
    message:
      override !== ""
        ? `Rift executable is missing or not executable: ${override}`
        : "Rift was not found on this machine. Install rift-snapshot or set its executable path in Rift settings.",
  };
}
