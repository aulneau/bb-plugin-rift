import { useEffect, useState } from "react";
import {
  experimental_BranchPicker,
  useRpc,
  useSettings,
  type JsonValue,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import type { RiftInputs } from "./inputs.js";
import type { settingsContract } from "./settings-contract.js";

const defaultInputs: RiftInputs = { branch: { kind: "default" } };
export function selectedBranch(value: JsonValue | null): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const branch = value.branch;
  if (typeof branch !== "object" || branch === null || Array.isArray(branch))
    return null;
  return branch.kind === "named" && typeof branch.name === "string"
    ? branch.name
    : null;
}
const BranchPicker = experimental_BranchPicker;

export function RiftBranchPicker({
  projectId,
  target,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  const rpc = useRpc<typeof settingsContract>();
  const { values } = useSettings();
  const [fallback, setFallback] = useState<{
    projectId: string;
    branch: string;
  } | null>(null);
  useEffect(() => {
    if (value === null) onChange({ status: "ready", value: defaultInputs });
  }, [value, onChange]);
  useEffect(() => {
    if (projectId === null) return;
    let active = true;
    void rpc.call("projectOptions", { projectId }).then(
      (state) => {
        if (active)
          setFallback({ projectId, branch: state.effective.startingBranch });
      },
      () => {
        if (active) setFallback(null);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, projectId, values?.startingBranch]);
  const defaultBranch =
    fallback?.projectId === projectId ? fallback?.branch : undefined;
  return (
    <BranchPicker
      projectId={projectId}
      hostId={target.kind === "existing-host" ? target.hostId : null}
      label="Branch from:"
      placeholder={`Branch from: ${defaultBranch ?? "Rift default"}`}
      value={selectedBranch(value)}
      onChange={(next) =>
        onChange({
          status: "ready",
          value:
            next === null
              ? defaultInputs
              : { branch: { kind: "named", name: next } },
        })
      }
    />
  );
}
