---
name: rift-environments
description: Create or troubleshoot Rift environments in BB, including automatic installation and updates, creation settings, offline copies, machine executable overrides and snapshot retention.
---

Use BB's standard environment picker and select Rift when starting a thread.

CLI: `bb thread spawn --project <id> --environment-provider rift --prompt "<task>"`.
Inspect providers with `bb environment providers --json`. Manage and reuse Rift environments through `bb environment` and `--environment <id>`.
The SDK equivalent is `bb.sdk.threads.spawn({ projectId, prompt, environment: { type: "provider", environmentProviderId: "rift", machine: { type: "existing", hostId }, inputs: null } })`.

Defaults: fetch `origin/main` before each new environment and reuse dependencies. `fetchBeforeCreate: false` uses the last-fetched tracking ref without network access; a missing ref stops creation. With fetching enabled, a failed fetch stops creation. `startingBranch` selects an origin remote branch and the BB diff base. Source branch, index and edits stay intact; fetching updates its tracking ref. New copies discard copied tracked edits and non-ignored untracked files. `reuseDependencies: false` additionally removes ignored recognized generated directories in the new copy before BB setup. Tracked files and local configuration outside those directories, including root/package `.env` files, remain. Existing environments and successful retries retain their recorded starting point.

Use Settings → Rift for defaults and its Rift installation and environment overrides section for scoped values. CLI defaults: `bb plugin config rift set <key> <value>`; keys are `fetchBeforeCreate`, `startingBranch`, `reuseDependencies`, `binaryPath`.

Read a project's effective options with `bb rift project <project-id>`. Set all three together with `bb rift project <project-id> set '{"fetchBeforeCreate":true,"startingBranch":"origin/main","reuseDependencies":true}'`. `bb rift project <project-id> reset` restores plugin defaults.

Read a machine's executable with `bb rift machine <machine-id>`. Set an absolute path with `bb rift machine <machine-id> set /absolute/path/to/rift`, save `''` for automatic installation and updates, or use `reset` to inherit the plugin default. First use installs a private, verified native Rift executable on that machine. BB checks daily for stable npm releases while enabled and online, retaining the working version when updates fail. Existing global Rift installations are left unchanged and can serve as an offline fallback. Invalid explicit paths fail rather than choosing another executable. Existing explicit plugin paths remain effective after upgrading.

Runtime controls: choose the machine in Settings → Rift to see its version, source, path and update status. Use `bb rift runtime <host-id>` for status, `check` to refresh release information, `install` to prepare a managed runtime, or `update` to install the latest stable release. `bb.sdk.plugins.callRpc` exposes the same `runtime` method with `{ hostId, action }` and `settingsContract.runtime.output`. Explicit paths remain user-managed; clear the effective override before requesting automatic updates. A first-time installation needs network access unless an existing compatible runtime is available. Download failures are visible in settings and can be retried there. Runtime installation never changes registry ownership.

SDK: `bb.sdk.plugins.updateSettings` changes defaults. `bb.sdk.plugins.callRpc` calls `projectOptions`, `saveProjectOptions`, `machineExecutable`, or `saveMachineExecutable`; use the schemas exported by `settingsContract`. Save `null` to reset an override. See [settings reference](../../README.md#settings) for argument shapes and the exact generated-directory cleanup list.

Support requires macOS/APFS, an original Git checkout and an origin remote. Linked worktrees and external Git object stores are refused. Existing Rift markers must belong to the plugin's registry or the standard macOS registry at `~/Library/Application Support/rift/rift.sqlite`; unknown custom registries are refused without changing ownership. Copies live adjacent to the checkout under `.bb-rifts` on the same volume. Rift adds its `.rift` marker to the source; existing siblings remain intact.

Archived threads retain their environments indefinitely. Explicit environment removal moves the snapshot into Rift's adjacent `.trash` directory, retaining independent Git commits and uncommitted files. BB teardown scripts run first. The plugin never runs `rift gc`. Read retained paths from the environment lifecycle log or the plugin's host-local `copies/<id>.plan.json` receipts. Partial unregistered copies move to `.retained`. Removal refuses registered child copies to avoid cascading into other work. BB never removes the source root or sibling copies. If you use Rift manually with a shared registry, removing a parent through Rift can also move its BB children.

Rebuild of a missing or explicitly removed environment stops rather than replacing its independent history. Restore the retained directory or start a new environment. Retrying a successfully created copy never resets its branch or files. Interrupted creation is retained for inspection and removal; after a hard worker crash, inspect running processes before removing a stale lock named in the failure message.

The copy is not an atomic multi-file snapshot of a changing source. Avoid installing dependencies in the source while creating a copy. Ignored dependency files may need the normal BB setup script to match the selected starting commit.
