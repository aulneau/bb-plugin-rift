import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type CommandResult =
  | { status: "ok"; stdout: string }
  | { status: "failed"; message: string };

const repositoryEnvironment = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_QUARANTINE_PATH",
];

export function runCommand(
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  if (signal.aborted)
    return Promise.resolve({
      status: "failed",
      message: "Operation cancelled.",
    });
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const name of repositoryEnvironment) delete env[name];
    const child = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env,
    });
    const output = new StringDecoder("utf8");
    const errors = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let stopped: string | null = null;
    let settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const terminate = (killSignal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch {}
    };
    const stop = (reason: string) => {
      if (stopped !== null) return;
      stopped = reason;
      terminate("SIGTERM");
      force = setTimeout(() => terminate("SIGKILL"), 1000);
    };
    const abort = () =>
      stop("Operation cancelled; any partial copy is retained for inspection.");
    const timeout = setTimeout(
      () => stop("Operation timed out after 15 minutes."),
      15 * 60_000,
    );
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (stopped !== null) terminate("SIGKILL");
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 128_000) {
        stop("Command output exceeded 128 KB.");
        return;
      }
      stdout += output.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + errors.write(chunk)).slice(-16_000);
    });
    child.once("error", (error) =>
      finish({ status: "failed", message: error.message }),
    );
    child.once("close", (code) => {
      stdout += output.end();
      stderr += errors.end();
      finish(
        stopped !== null
          ? { status: "failed", message: stopped }
          : code === 0
            ? { status: "ok", stdout: stdout.replace(/\r?\n$/, "") }
            : {
                status: "failed",
                message: stderr.trim() || `${binary} exited with code ${code}.`,
              },
      );
    });
  });
}
