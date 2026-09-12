import { useEffect, useState } from "react";
import { definePluginApp, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { settingsContract } from "./settings-contract.js";
import type { RuntimeState, RuntimeAction } from "./runtime-contract.js";
import { newerVersion } from "./runtime-version.js";
import type { ProjectOptions } from "./options.js";
import "./app.css";
import { RiftBranchPicker } from "./branch-picker.js";

type Choices = z.infer<typeof settingsContract.choices.output>;
type ProjectState = z.infer<typeof settingsContract.projectOptions.output>;
type MachineState = z.infer<typeof settingsContract.machineExecutable.output>;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function ProjectEditor({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof settingsContract>();
  const { values } = useSettings();
  const [view, setView] = useState<ProjectState | null>(null);
  const [draft, setDraft] = useState<ProjectOptions | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void rpc.call("projectOptions", { projectId }).then(
      (next) => {
        if (!active) return;
        setView(next);
        setDraft(next.effective);
        setError("");
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [
    rpc,
    projectId,
    values?.fetchBeforeCreate,
    values?.startingBranch,
    values?.reuseDependencies,
    reload,
  ]);
  async function save(value: ProjectOptions | null) {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await rpc.call("saveProjectOptions", { projectId, value });
      setView(next);
      setDraft(next.effective);
      setNotice(
        value === null ? "Using plugin defaults." : "Project settings saved.",
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="rift-settings-editor">
      {draft === null ? (
        <p role="status">Loading project settings…</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <fieldset disabled={saving}>
            <p>
              {view?.override === null
                ? "Using plugin defaults. Saving creates an override for this project."
                : "This project has its own creation settings."}
            </p>
            <label className="rift-check">
              <input
                type="checkbox"
                checked={draft.fetchBeforeCreate}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    fetchBeforeCreate: event.target.checked,
                  })
                }
              />
              Fetch before creating
            </label>
            <label>
              Starting branch
              <input
                required
                value={draft.startingBranch}
                onChange={(event) =>
                  setDraft({ ...draft, startingBranch: event.target.value })
                }
                spellCheck={false}
              />
            </label>
            <label className="rift-check">
              <input
                type="checkbox"
                checked={draft.reuseDependencies}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    reuseDependencies: event.target.checked,
                  })
                }
              />
              Reuse dependencies and build caches
            </label>
            <div className="rift-settings-actions">
              <button type="submit">
                {saving ? "Saving…" : "Save project settings"}
              </button>
              <button
                type="button"
                disabled={view?.override === null}
                onClick={() => void save(null)}
              >
                Use plugin defaults
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {error !== "" && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={saving}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload settings
          </button>
        </div>
      )}
      {notice !== "" && <p role="status">{notice}</p>}
    </div>
  );
}

function RuntimeEditor({ hostId }: { hostId: string }) {
  const rpc = useRpc<typeof settingsContract>();
  const [state, setState] = useState<RuntimeState | null>(null);
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void rpc.call("runtime", { hostId, action: "status" }).then(
      (next) => {
        if (active) setState(next);
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, hostId]);
  async function run(action: RuntimeAction) {
    if (busy !== null) return;
    setBusy(action);
    setError("");
    try {
      setState(await rpc.call("runtime", { hostId, action }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }
  const installed = state?.installation;
  const ready = installed?.status === "ready" ? installed : null;
  const managed = ready?.source === "managed";
  const overridden = ready?.source === "override";
  const updateAvailable =
    ready?.version !== null &&
    ready?.version !== undefined &&
    state?.latestVersion !== null &&
    state?.latestVersion !== undefined &&
    newerVersion(state.latestVersion, ready.version);
  return (
    <section
      className="rift-runtime"
      aria-label="Rift installation"
      aria-busy={busy !== null}
    >
      <strong>Rift installation</strong>
      {state === null && error === "" && (
        <p role="status">Checking installation…</p>
      )}
      {ready !== null && (
        <>
          <p>
            Rift {ready.version ?? "(version unavailable)"} ·{" "}
            {managed
              ? "Managed by BB"
              : overridden
                ? "Executable override"
                : "Existing installation"}
          </p>
          <p className="rift-runtime-path">{ready.binaryPath}</p>
          <p>
            {managed
              ? "BB checks daily and installs updates automatically. Previous versions are retained."
              : overridden
                ? "This executable is user-managed. Clear the override to enable automatic installation and updates."
                : "BB will prepare a managed installation on first use. Your existing installation stays unchanged."}
          </p>
        </>
      )}
      {installed?.status === "missing" && (
        <p>
          Rift will install automatically when you create your first
          environment. You can also install it now.
        </p>
      )}
      {installed?.status === "failed" && (
        <p role="alert">{installed.message}</p>
      )}
      {updateAvailable && <p>Rift {state?.latestVersion} is available.</p>}
      {managed && state?.latestVersion === ready?.version && (
        <p>Up to date with the last update check.</p>
      )}
      {state?.checkedAt !== null && state?.checkedAt !== undefined && (
        <p>Last checked: {new Date(state.checkedAt).toLocaleString()}</p>
      )}
      <div className="rift-settings-actions">
        <button
          disabled={busy !== null}
          onClick={() => void run(overridden ? "status" : "check")}
        >
          {busy === "check" || busy === "status"
            ? "Checking…"
            : overridden
              ? "Refresh"
              : "Check for updates"}
        </button>
        {!overridden && installed?.status !== "failed" && state !== null && (
          <button
            disabled={busy !== null}
            onClick={() => void run(managed ? "update" : "install")}
          >
            {busy === "install"
              ? "Installing Rift…"
              : busy === "update"
                ? "Updating Rift…"
                : managed
                  ? "Update Rift"
                  : ready !== null
                    ? "Use managed Rift"
                    : "Install Rift"}
          </button>
        )}
      </div>
      {busy !== null && (
        <p role="status">
          {busy === "install" || busy === "update"
            ? "Downloading and verifying Rift on this machine…"
            : "Checking Rift on this machine…"}
        </p>
      )}
      {state?.updateError !== null && state?.updateError !== undefined && (
        <p role="alert">
          {state.updateError}
          {ready !== null
            ? " Your current installation is still available."
            : " Retry the installation when the connection is available."}
        </p>
      )}
      {error !== "" && <p role="alert">{error}</p>}
    </section>
  );
}

function MachineEditor({ hostId }: { hostId: string }) {
  const rpc = useRpc<typeof settingsContract>();
  const { values } = useSettings();
  const [view, setView] = useState<MachineState | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void rpc.call("machineExecutable", { hostId }).then(
      (next) => {
        if (!active) return;
        setView(next);
        setDraft(next.effective);
        setError("");
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, hostId, values?.binaryPath, reload]);
  async function save(value: string | null) {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await rpc.call("saveMachineExecutable", { hostId, value });
      setView(next);
      setDraft(next.effective);
      setNotice(
        value === null ? "Using plugin default." : "Machine setting saved.",
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="rift-settings-editor">
      {view !== null && <RuntimeEditor key={view.effective} hostId={hostId} />}
      {view === null ? (
        <p role="status">Loading machine settings…</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <fieldset disabled={saving}>
            <p>
              {view.override === null
                ? "Using the plugin default. Saving affects only this machine."
                : "This machine has its own executable setting."}
            </p>
            <label>
              Rift executable override
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Managed automatically"
                spellCheck={false}
              />
            </label>
            <p>
              Save an empty path to let BB install and update Rift on this
              machine, even when the plugin default specifies a path.
            </p>
            <div className="rift-settings-actions">
              <button type="submit">
                {saving ? "Saving…" : "Save machine setting"}
              </button>
              <button
                type="button"
                disabled={view.override === null}
                onClick={() => void save(null)}
              >
                Use plugin default
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {error !== "" && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={saving}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload settings
          </button>
        </div>
      )}
      {notice !== "" && <p role="status">{notice}</p>}
    </div>
  );
}

function Overrides() {
  const rpc = useRpc<typeof settingsContract>();
  const [choices, setChoices] = useState<Choices | null>(null);
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [hostId, setHostId] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void rpc.call("choices", {}).then(
      (next) => {
        if (active) {
          setChoices(next);
          setError("");
        }
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, reload]);
  return (
    <div className="rift-settings">
      <p>
        The settings above are defaults for new environments. Existing
        environments keep their files and starting commit.
      </p>
      {error !== "" ? (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setReload((value) => value + 1)}>Retry</button>
        </div>
      ) : choices === null ? (
        <p role="status">Loading projects and machines…</p>
      ) : (
        <>
          <section aria-label="Project overrides">
            <label>
              Project
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Choose a project</option>
                {choices.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {projectId !== "" && (
              <ProjectEditor key={projectId} projectId={projectId} />
            )}
          </section>
          <section aria-label="Machine overrides">
            <label>
              Machine
              <select
                value={hostId}
                onChange={(event) => setHostId(event.target.value)}
              >
                <option value="">Choose a machine</option>
                {choices.machines.map((machine) => (
                  <option key={machine.id} value={machine.id}>
                    {machine.name}
                  </option>
                ))}
              </select>
            </label>
            {hostId !== "" && <MachineEditor key={hostId} hostId={hostId} />}
          </section>
        </>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: "rift",
    component: RiftBranchPicker,
  });
  app.slots.settingsSection({
    id: "overrides",
    title: "Rift installation and environment overrides",
    component: Overrides,
  });
});
