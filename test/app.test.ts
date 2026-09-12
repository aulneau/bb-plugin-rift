import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import { defaultProjectOptions } from "../options.js";
import type { ProjectOptions } from "../options.js";
import type { RuntimeState } from "../runtime-contract.js";
import type { settingsContract } from "../settings-contract.js";

test("settings UI saves project and machine overrides, resets them and reports validation errors", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), "__bbPluginRuntime"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const hooks = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    },
  });
  try {
    const { loadPluginApp, renderSlot } =
      await import("@get-bb/plugin-sdk/testing/app");
    const { fireEvent, waitFor, cleanup, act } =
      await import("@testing-library/react");
    const app = await loadPluginApp(() => import("../app.js"));
    const section = app.settingsSections[0];
    assert.ok(section);
    let projectOverride: ProjectOptions | null = null;
    let machineOverride: string | null = null;
    let runtime: RuntimeState = {
      installation: { status: "missing" },
      latestVersion: null,
      checkedAt: null,
      updateError: null,
    };
    let failUpdate = true;
    const slot = renderSlot<{}, typeof settingsContract>(
      section,
      {},
      {
        rpc: {
          runtime: async ({ action }) => {
            if (action === "install")
              runtime = {
                installation: {
                  status: "ready",
                  source: "managed",
                  version: "0.0.10",
                  binaryPath: "/managed/rift",
                },
                latestVersion: "0.0.10",
                checkedAt: 1000,
                updateError: null,
              };
            if (action === "check")
              runtime = {
                ...runtime,
                latestVersion: "0.0.11",
                checkedAt: 2000,
              };
            if (action === "update") {
              if (failUpdate) {
                failUpdate = false;
                throw new Error("Download interrupted");
              }
              runtime = {
                installation: {
                  status: "ready",
                  source: "managed",
                  version: "0.0.11",
                  binaryPath: "/managed/new-rift",
                },
                latestVersion: "0.0.11",
                checkedAt: 3000,
                updateError: null,
              };
            }
            return runtime;
          },
          choices: async () => ({
            projects: [{ id: "proj_one", name: "Fixture project" }],
            machines: [{ id: "host_one", name: "Fixture Mac" }],
          }),
          projectOptions: async () => ({
            effective: projectOverride ?? defaultProjectOptions,
            override: projectOverride,
          }),
          machineExecutable: async () => ({
            effective: machineOverride ?? "/default/rift",
            override: machineOverride,
          }),
          saveProjectOptions: async ({ value }) => {
            if (value?.startingBranch === "invalid")
              throw new Error("Use an origin branch.");
            projectOverride = value;
            return {
              effective: value ?? defaultProjectOptions,
              override: value,
            };
          },
          saveMachineExecutable: async ({ value }) => {
            machineOverride = value;
            return { effective: value ?? "/default/rift", override: value };
          },
        },
      },
    );
    try {
      fireEvent.change(await slot.findByLabelText("Project"), {
        target: { value: "proj_one" },
      });
      const branch = await slot.findByLabelText("Starting branch");
      fireEvent.change(branch, { target: { value: "origin/develop" } });
      fireEvent.click(slot.getByLabelText("Fetch before creating"));
      fireEvent.click(
        slot.getByLabelText("Reuse dependencies and build caches"),
      );
      fireEvent.click(
        slot.getByRole("button", { name: "Save project settings" }),
      );
      await slot.findByText("Project settings saved.");
      assert.deepEqual(projectOverride, {
        startingBranch: "origin/develop",
        fetchBeforeCreate: false,
        reuseDependencies: false,
      });
      fireEvent.change(branch, { target: { value: "invalid" } });
      fireEvent.click(
        slot.getByRole("button", { name: "Save project settings" }),
      );
      await slot.findByRole("alert");
      assert.deepEqual(projectOverride, {
        startingBranch: "origin/develop",
        fetchBeforeCreate: false,
        reuseDependencies: false,
      });
      fireEvent.click(
        slot.getByRole("button", { name: "Use plugin defaults" }),
      );
      await waitFor(() => assert.equal(projectOverride, null));
      fireEvent.change(slot.getByLabelText("Machine"), {
        target: { value: "host_one" },
      });
      const executable = await slot.findByLabelText("Rift executable override");
      fireEvent.click(
        await slot.findByRole("button", { name: "Install Rift" }),
      );
      await slot.findByText("Rift 0.0.10 · Managed by BB");
      fireEvent.click(slot.getByRole("button", { name: "Check for updates" }));
      await slot.findByText("Rift 0.0.11 is available.");
      fireEvent.click(slot.getByRole("button", { name: "Update Rift" }));
      await slot.findByText("Download interrupted");
      assert.ok(slot.getByText("Rift 0.0.10 · Managed by BB"));
      fireEvent.click(slot.getByRole("button", { name: "Update Rift" }));
      await slot.findByText("Rift 0.0.11 · Managed by BB");
      fireEvent.change(executable, { target: { value: "" } });
      fireEvent.click(
        slot.getByRole("button", { name: "Save machine setting" }),
      );
      await slot.findByText("Machine setting saved.");
      assert.equal(machineOverride, "");
      fireEvent.click(
        slot.getByRole("button", { name: /^Use plugin default$/ }),
      );
      await slot.findByText("Using plugin default.");
      assert.equal(machineOverride, null);
    } finally {
      await act(async () => {
        slot.lifecycle.unmount();
        cleanup();
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    }
  } finally {
    hooks.deregister();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }
});
