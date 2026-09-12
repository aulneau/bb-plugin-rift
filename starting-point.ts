import { runCommand } from "./process.js";

export async function resolveStartingPoint(
  source: string,
  branch: string,
  fetchBeforeCreate: boolean,
  signal: AbortSignal,
) {
  const remotes = await runCommand("git", ["remote"], source, signal);
  if (remotes.status === "failed") return remotes;
  const remote = remotes.stdout
    .split("\n")
    .filter((name) => name !== "" && branch.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  const ref =
    remote === undefined ? `refs/heads/${branch}` : `refs/remotes/${branch}`;
  if (remote !== undefined && fetchBeforeCreate) {
    const name = branch.slice(remote.length + 1);
    const fetched = await runCommand(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "fetch",
        "--no-tags",
        "--",
        remote,
        `+refs/heads/${name}:${ref}`,
      ],
      source,
      signal,
    );
    if (fetched.status === "failed")
      return {
        status: "failed" as const,
        message: `Could not fetch latest ${branch}; no stale environment was created. ${fetched.message}`,
      };
  }
  const head = await runCommand(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    source,
    signal,
  );
  if (head.status === "failed" || !/^[a-f0-9]{40,64}$/.test(head.stdout))
    return {
      status: "failed" as const,
      message:
        remote === undefined
          ? `Local branch ${branch} is unavailable on this machine.`
          : fetchBeforeCreate
            ? `Could not resolve the freshly fetched ${branch} commit.`
            : `No cached ${branch} commit is available. Enable fetching or fetch this branch manually first.`,
    };
  return { status: "ready" as const, commit: head.stdout };
}
