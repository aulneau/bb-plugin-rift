# Rift environments for BB

Select **Rift** in BB's new-thread environment picker. BB creates an independent APFS copy and launches the thread inside it.

By default, each new environment fetches `origin/main`, starts its branch at that exact commit, and reuses dependencies. Fetch failures stop creation. The source keeps its branch, index and local edits; fetching updates its remote-tracking ref. The new copy discards copied tracked edits and non-ignored untracked files. BB runs its normal setup script afterward. Existing environments never auto-reset when settings or remote branches change.

```sh
bb thread spawn --project <project-id> --environment-provider rift --prompt "Your task"
bb environment providers --json
```

Requires BB with Plugin SDK 0.4.50+, macOS/APFS, an original Git checkout, and an origin remote. Rift installs automatically on the execution machine when you first create an environment. Linked worktrees are unsupported. Existing checkouts in the standard Rift registry are recognized without reinitializing their markers. An explicit executable override takes precedence and remains user-managed.

Copies reside next to the original checkout under `.bb-rifts`. Archiving threads retains copies. Explicit environment removal moves copies into adjacent `.trash`, keeping their Git history and files; automatic garbage collection is disabled. Removal refuses copies with descendants. Missing environments are not automatically rebuilt because that could replace independent history. Retained paths appear in lifecycle logs. See [operating guidance](skills/rift-environments/SKILL.md).

## Install

Install [BB](https://getbb.app), then run:

```sh
bb plugin install https://github.com/aulneau/bb-plugin-rift
```

Select **Rift** when creating a thread. BB installs Rift on that machine automatically and keeps it updated. Requires macOS with an APFS volume.

## Install from a checkout

Install [BB](https://getbb.app), then run these commands from this repository:

```sh
npm ci --include=dev
bb plugin build .
bb plugin install .
```

Select Rift in the new-thread environment picker. BB remembers this choice per project.

## Installation and updates

Rift runs on the machine containing the checkout. With an empty executable override, first use downloads the latest stable `rift-snapshot` package from npm, verifies its SHA-512 integrity, extracts the matching native executable, and checks the required CLI capabilities before activating it. No global npm installation, compiler, shell setup or separate Node installation is needed on that machine. Opening the environment picker performs local checks only.

Open **Settings → Rift**, choose a machine, and use **Install Rift**, **Check for updates**, or **Update Rift**. The section shows the installation source, executable location, known package version, last check and errors. **Use managed Rift** prepares a private installation when an existing compatible executable was discovered.

BB checks used machines at most once daily and automatically installs updates. An hourly schedule handles connected machines; environment creation also checks when due. Update checks and installation failures are retried on the next daily maintenance pass, or immediately through the UI/CLI. Missing first-time installations can be retried by creating an environment again. A disconnected machine catches up on use or the next maintenance pass. Updates run only while the plugin is enabled in a running BB server. Active copy operations continue using the executable they already resolved.

A failed update leaves the working installation available and displays the error in settings. A failed first installation without an existing compatible executable stops creation with an actionable error. Cached managed versions work offline; the separate fetch-before-create setting still controls Git network access. Older managed executables are retained. Downloaded executables live under the plugin's persistent per-machine `runtime/` directory, separate from checkout registries and copy receipts. Installing or updating never reinitializes a registry, deletes snapshots, or runs Rift garbage collection.

An explicit path disables managed installation and updates for that machine. Existing global Rift installations are never changed. If managed installation fails and a compatible Rift is found on PATH or in common Homebrew/Cargo/local/Bun locations, it can be used as a fallback. Rift 0.0.10 has no `--version` command; existing installations report their enclosing npm package version when available, otherwise the UI says the version is unavailable. Managed versions are known from the verified package metadata.

```sh
bb rift runtime <machine-id>
bb rift runtime <machine-id> check
bb rift runtime <machine-id> install
bb rift runtime <machine-id> update
```

These commands return the same state as the UI: `installation`, `latestVersion`, `checkedAt`, and `updateError`. SDK callers use `bb.sdk.plugins.callRpc({ pluginId: "rift", method: "runtime", input: { hostId, action: "update" }, outputSchema: settingsContract.runtime.output })`. Public actions are `status`, `check`, `install`, and `update`; `maintain` performs the scheduled, daily-throttled check for machines where automatic setup has already been attempted.

## Settings

Open **Settings → Rift**. The generated fields set plugin-wide defaults; the **Rift installation and environment overrides** section lets a project use its own creation options and a machine use its own executable path. Saving a project override replaces all three creation options together. Reset returns that project or machine to the current plugin defaults. Settings apply when creating a new environment; completed-copy retries retain their recorded starting branch and commit.

| Key                 | Default       | Behavior                                                                                                                                              |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchBeforeCreate` | `true`        | Fetch the selected origin branch before copying. With `false`, use its last-fetched local tracking ref without network access; fail if it is missing. |
| `startingBranch`    | `origin/main` | An origin remote branch, including nested names such as `origin/release/next`. It also becomes the BB diff base.                                      |
| `reuseDependencies` | `true`        | With `false`, clean only ignored recognized generated directories in the new copy before BB setup.                                                    |
| `binaryPath`        | Empty         | Install and update a private Rift automatically; an absolute path selects a user-managed executable.                                                  |

Dependency cleanup covers `node_modules`, `target`, `dist`, `build`, `coverage`, `.venv`, `venv`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, and `.ruff_cache`, including nested packages. Tracked files are protected. Files inside those ignored generated directories are disposable; local configuration outside them, including root and package `.env` files, and other ignored data are preserved. Cleanup identifies exact ignored paths before deletion and never follows dependency symlinks into other directories. The source is unchanged. Large inspection output causes creation to fail with its partial copy retained rather than continuing with incomplete cleanup.

CLI equivalents:

```sh
bb plugin config rift set fetchBeforeCreate false
bb plugin config rift set startingBranch origin/develop
bb plugin config rift set reuseDependencies false
bb plugin config rift set binaryPath /absolute/path/to/rift
bb plugin config rift unset binaryPath

bb rift project <project-id>
bb rift project <project-id> set '{"fetchBeforeCreate":true,"startingBranch":"origin/main","reuseDependencies":true}'
bb rift project <project-id> reset

bb rift machine <machine-id>
bb rift machine <machine-id> set /absolute/path/to/rift
bb rift machine <machine-id> set ''
bb rift machine <machine-id> reset
```

An empty machine override explicitly selects automatic management even if the plugin default contains a path. Resetting the machine override inherits that default instead. Read commands return JSON containing `effective` and `override`; `null` means no override.

SDK clients can use `bb.sdk.plugins.updateSettings` for defaults and `bb.sdk.plugins.callRpc` with the exported `settingsContract` for scoped values. The same validated RPC methods back the settings UI:

```ts
await bb.sdk.plugins.callRpc({
  pluginId: "rift",
  method: "saveProjectOptions",
  input: {
    projectId,
    value: {
      fetchBeforeCreate: true,
      startingBranch: "origin/develop",
      reuseDependencies: false,
    },
  },
  outputSchema: settingsContract.saveProjectOptions.output,
});
```

Use `projectOptions`, `saveProjectOptions`, `machineExecutable`, and `saveMachineExecutable` to read or replace overrides. Save `null` to reset. `choices` returns the project and machine selectors.

## Development

The checked-in `types/bb-plugin-sdk.d.ts` declarations are generated by `bb plugin types .` from the installed BB version. They were refreshed against BB 0.43.0 (SDK 0.4.84). The npm SDK 0.4.48 dependency supplies the backend, host and UI test harnesses. UI tests use JSDOM, and backend tests use a real SQLite database. The separate runtime test tsconfig avoids treating declarations as executable modules.

```sh
npm install --include=dev
RIFT_TEST_BINARY=/absolute/path/to/rift npx turbo run typecheck test
bb plugin build .
bb plugin reload rift
```

Tests use real Git remotes, the native Rift binary and the public host harness. They cover fetch/offline behavior, alternate branches, selective dependency cleanup, executable discovery, automatic runtime setup and updates, integrity rejection, offline fallback, settings UI and CLI, scoped persistence, legacy receipts, source preservation, retention, concurrency and cancellation.

## Performance and recovery

Repeated picker checks share work and reuse successful results for three seconds. Each host worker holds at most 64 inspection entries and cancels outstanding checks when it stops. Failed checks can be retried immediately. New environment creation always performs fresh validation and follows the resolved fetch setting.

Requests for the same checkout queue behind a filesystem lock; unrelated checkouts proceed independently. A 30-second lock timeout is reported to BB as retryable. Completed-copy retries read the saved receipt without running Git or Rift or waiting for another copy of the source. Concurrent removal of the same environment returns the same retained path. After a worker crash, inspect running Rift processes before removing a stale lock identified in the error.

The host owns checkout inspection (`checkout.ts`), process execution (`process.ts`) and copy lifecycle (`workspace.ts`). `server.ts` registers the BB environment provider and maps host results to BB lifecycle outcomes. Git repository overrides inherited from the host are cleared before commands run; authentication settings remain available. Commands have bounded output, a timeout and process-group cancellation.

Run the reproducible local benchmark with:

```sh
RIFT_TEST_BINARY=/absolute/path/to/rift npx turbo run benchmark
```

See [verification and measurements](VERIFICATION.md) for results and their limits.

## License

[MIT](LICENSE). Powered by [Rift](https://github.com/anomalyco/rift).
