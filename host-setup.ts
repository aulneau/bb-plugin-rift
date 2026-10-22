import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists } from "./filesystem.js";
import { runCommand } from "./process.js";

// A machine can bring a new copy's dependencies in line without anything committed to the
// repository: if <setup dir>/<repo>.sh exists, it runs in the new copy after checkout and
// before BB's own .bb-env-setup.sh. <repo> is the source checkout's directory name.
// The setup dir is $BB_RIFT_SETUP_DIR, else $XDG_CONFIG_HOME/bb-rift/setup, else
// ~/.config/bb-rift/setup. Output goes to .git/bb-rift-setup.log in the copy.
export function hostSetupDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
) {
  if (env.BB_RIFT_SETUP_DIR && path.isAbsolute(env.BB_RIFT_SETUP_DIR))
    return env.BB_RIFT_SETUP_DIR;
  const config =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(home, ".config");
  return path.join(config, "bb-rift", "setup");
}

export async function runHostSetup(
  source: string,
  target: string,
  signal: AbortSignal,
  dir: string = hostSetupDir(),
) {
  const script = path.join(dir, `${path.basename(source)}.sh`);
  if (!(await exists(script))) return { status: "skipped" as const };
  const log = path.join(target, ".git", "bb-rift-setup.log");
  const result = await runCommand(
    "bash",
    ["-c", 'exec >>"$1" 2>&1; exec bash "$2"', "bb-rift-setup", log, script],
    target,
    signal,
  );
  if (result.status === "ok") return { status: "ran" as const, script };
  const tail = await fs
    .readFile(log, "utf8")
    .then((text) => text.split("\n").slice(-20).join("\n"))
    .catch(() => "");
  return {
    status: "failed" as const,
    message: `Machine setup ${script} failed: ${result.message}\n${tail}\nLog: ${log}`,
  };
}
