# Verification

## 2026-09-12 — native branch picker (0.6.0)

BB 0.43.0 / SDK 0.4.84; public npm test harness upgraded to 0.4.53 to exercise environment provider inputs and the native branch picker.

- Turbo typecheck and all 36 tests pass with native Rift enabled. Added tests cover branch-input validation, default and per-environment resolution, provider-to-host routing, the receipt's diff base, picker registration/machine/project binding, the configured default label, selection and clearing, local unpushed commits without network access, named remote fetching, missing branches and retry preservation after a changed selection.
- Built and reloaded version 0.6.0 in the active BB. The live provider advertises the default/named branch input schema, accepts empty inputs, and reports available. BB reports its 10,982-byte frontend compatible with SDK 0.4.84. Live visual inspection was unavailable; picker interaction was exercised through the public UI harness.
- The frontend uses BB's shared branch control through its environment-provider input slot. BB owns branch loading, search, refresh and the dropdown UI. Plugin inputs are validated server-side and through the host contract.
- Existing project defaults remain origin branches; per-environment choices also accept local branches and other configured remotes. Remote-prefixed names select remote tracking refs; other names select local heads.
- The SDK host entry imports its declaration helper from the public root export, avoiding an unrelated dynamic-require failure in the npm 0.4.53 host module during Node tests. Vendored declarations remain matched to the active BB version.

## 2026-09-12 — automatic Rift installation and updates (0.5.0)

Verified with BB 0.43.0, SDK 0.4.84, macOS arm64 and the official Rift 0.0.10 npm package.

- Turbo typecheck and all 32 tests pass, with no skipped native tests. New coverage includes concurrent first installation, daily maintenance, explicit overrides, rejected and offline updates, cancellation cleanup, archive member extraction, integrity rejection, CLI/RPC machine routing, UI installation/update/error/retry behavior, and first-use creation through the public host contract.
- A real npm download verified SHA-512 integrity, extracted the native executable, passed its capability probe and activated successfully in 1.93 seconds on this machine. An immediate update reused the same version. This single local observation is not a general download-time benchmark.
- Built and reloaded the actual standalone plugin in the active BB. The app bundle is 10,025 bytes and reports compatibility with SDK 0.4.84. The hourly `rift-updates` schedule is registered; daily throttling and automatic version activation were exercised with an advancing test clock.
- Replaced the earlier temporary global executable setting with automatic management. Live CLI install, check and update returned managed Rift 0.0.10 with no update error. BB now uses its persistent plugin host-data runtime directory, and the previous executable remains intact.
- The live per-machine provider check reports Rift available for an existing project checkout. A native host-contract test proves that a missing runtime stays selectable, installs during creation, preserves completed retries and removes through normal snapshot retention.
- No browser was connected to this session. Settings interactions were verified with BB's public React/JSDOM harness; visual inspection in the live settings page remains unverified.

Runtime binaries are separate from copy receipts and registries. All prior source-preservation, ownership, dependency cleanup, retention and recovery tests pass. Automatic updates follow stable npm releases and validate the required CLI flags; this does not prove compatibility with every future upstream registry format.

## 0.4.0 — creation settings

Added native settings defaults, project creation overrides, machine executable overrides and matching CLI/RPC access. Fresh-main fetching and dependency reuse remain enabled by default. Existing explicit executable paths are preserved.

A clean npm install passed typecheck and all 24 tests. Built and reloaded in BB 0.43.0: Rift reports version 0.4.0, running status, a compatible 7,120-byte frontend bundle, all four native settings descriptors, and available host status. A temporary live project verified saving, reading, scope isolation, invalid-ref rejection and resetting through `bb rift project`; its override, project and directory were removed afterward. Existing user defaults and the executable path were unchanged.

Turbo typecheck and 24 tests pass, including real Git/Rift tests for offline cached refs, missing refs, fresh alternate branches, selective dependency cleanup, tracked artifacts, configuration preservation, external dependency symlinks, executable discovery, and old receipt/plan recovery. The backend harness uses real SQLite to verify override scope, validation and persistence across reload. The UI harness exercises saving, resetting and error feedback in the settings section. Native browser verification was unavailable in this session; the UI was exercised through BB’s public harness with JSDOM.

The app uses BB’s shared React runtime and adds only a settings section. No new navigation page, polling loop, or background fetch is introduced. Cleanup enumerates ignored entries before targeting exact generated-directory paths; Git glob pathspecs were rejected after a regression test showed they could include unrelated ignored directories.

## 2026-09-12 — performance and reliability

Plugin 0.3.0, BB 0.43.0 declarations (SDK 0.4.84), npm host harness 0.4.48, native Rift 0.0.10, macOS arm64/APFS.

Built and reloaded in the active BB 0.43.0 installation. The installed plugin reports version 0.3.0 and running status; the live host availability probe reports available for an existing project checkout. Installed source matches the verified staging tree. This pass exercised creation/removal through the real native binary and host harness; the full BB thread-launch workflow was last exercised on 2026-09-09, below.

Turbo typecheck and 17 tests pass from a clean dependency install. The new checks cover queued creation, duplicate IDs across sources, simultaneous removal, completed-copy recovery with a missing source and executable while the source lock is held, cache sharing/expiry/failure/disposal/capacity, cancellation while waiting for a lock, inherited Git repository overrides, split UTF-8 output, byte limits and termination of descendants that ignore SIGTERM.

The benchmark uses 1,000 tracked files, 4,000 ignored dependency files, a local bare Git remote and seven sequential samples per operation. Both versions use the same fixture and measurement script. Durations are medians in milliseconds:

| Operation                  |  0.2.0 |  0.3.0 |
| -------------------------- | -----: | -----: |
| Repeated picker inspection |  38.80 |   0.07 |
| New copy, including fetch  | 448.08 | 416.44 |
| Completed-copy retry       |  43.59 |   0.50 |

The picker median measures warm cache hits; the first 0.3.0 check took 30.37 ms. The copy timing improvement is modest and individual samples overlap. These measurements exclude BB transport, agent startup and remote network latency; they do not predict total thread startup time or large-repository behavior. Raw samples are in [before.json](benchmarks/results/before.json) and [after.json](benchmarks/results/after.json).

Unused UI development dependencies were removed: the lockfile contains 45 dependency entries instead of 224, including platform-specific entries. Zod remains the sole runtime dependency. This reduces development installation weight; it is separate from the measured host-operation latency.

The lifecycle contract remains: each new copy fetches fresh main, preserves source edits and ignored files, owns independent Git storage, retains snapshots on removal, and refuses unknown Rift registry ownership. Successful receipts and existing removal plans retain their persisted schema. Locks now serialize concurrent requests; timeout maps to a transient creation failure. No new public BB SDK surface is required.

## 2026-09-09 — native BB workflow

Installed on BB Nightly 0.42.2-nightly.34361658762.1, SDK 0.4.50, macOS arm64, native Rift 0.0.10.

- Turbo typecheck and all seven real Git/Rift integration tests pass.
- Native new-thread picker displays Rift; launching from it created a managed Rift environment and ran the normal BB setup script before the agent started.
- A second environment launched through `bb thread spawn --environment-provider rift` fetched a second remote main advance and used origin/main for its diff base.
- Explicit environment deletion reached destroyed status and retained its independent Git repository in adjacent trash.
- Existing-registry regression: BB recognized a checkout in the standard Rift registry, created a new environment on freshly fetched main, and launched the agent successfully. The original checkout's marker, HEAD and working status, plus an existing sibling copy's HEAD and working status, matched before and after both creation and cleanup.
- Fixture projects and verification threads were removed. Retained snapshots and host receipts follow the plugin's normal retention policy.

The tests additionally cover failed fetches, invalid ownership, linked-worktree rejection, idempotent retries/removal, cancellation, partial creation retention, and descendant removal refusal.
