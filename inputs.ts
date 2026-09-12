import { z } from "zod";
import { branchNameSchema, type ProjectOptions } from "./options.js";

export const riftInputsSchema = z
  .object({
    branch: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("default") }).strict(),
        z.object({ kind: z.literal("named"), name: branchNameSchema }).strict(),
      ])
      .default({ kind: "default" }),
  })
  .strict()
  .default({ branch: { kind: "default" } });
export type RiftInputs = z.infer<typeof riftInputsSchema>;

export function creationOptions(defaults: ProjectOptions, inputs: RiftInputs) {
  return {
    ...defaults,
    startingBranch:
      inputs.branch.kind === "named"
        ? inputs.branch.name
        : defaults.startingBranch,
  };
}
