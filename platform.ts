import os from "node:os";
import path from "node:path";

// Rift copies need copy-on-write: APFS clones on macOS, reflinks (XFS) or
// snapshots (btrfs) on Linux. Rift publishes prebuilds for these platforms.
export const supportedPlatforms = ["darwin-arm64", "darwin-x64", "linux-x64"];

export const unsupportedMessage =
  "Rift environments support macOS (APFS) and Linux x64 (XFS or btrfs) only.";

export const isSupportedPlatform = (platform: string) =>
  supportedPlatforms.includes(platform);

export const currentPlatform = () => `${process.platform}-${process.arch}`;

// Rift's own registry (`dirs::data_local_dir()/rift/rift.sqlite`).
export function standardRegistry(
  platform: string = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support", "rift", "rift.sqlite");
  const data =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.join(home, ".local", "share");
  return path.join(data, "rift", "rift.sqlite");
}
