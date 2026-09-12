import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { runtimeActionSchema, runtimeStateSchema } from "./runtime-contract.js";
import { executableSchema, projectOptionsSchema } from "./options.js";

const projectIdSchema = z.string().regex(/^proj_[a-zA-Z0-9_-]+$/);
const hostIdSchema = z.string().regex(/^host_[a-zA-Z0-9_-]+$/);
const projectState = z
  .object({
    effective: projectOptionsSchema,
    override: projectOptionsSchema.nullable(),
  })
  .strict();
const machineState = z
  .object({
    effective: executableSchema,
    override: executableSchema.nullable(),
  })
  .strict();
export const settingsContract = defineRpcContract({
  runtime: {
    input: z
      .object({ hostId: hostIdSchema, action: runtimeActionSchema })
      .strict(),
    output: runtimeStateSchema,
  },
  choices: {
    input: z.object({}).strict(),
    output: z
      .object({
        projects: z.array(
          z.object({ id: projectIdSchema, name: z.string() }).strict(),
        ),
        machines: z.array(
          z.object({ id: hostIdSchema, name: z.string() }).strict(),
        ),
      })
      .strict(),
  },
  projectOptions: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: projectState,
  },
  saveProjectOptions: {
    input: z
      .object({
        projectId: projectIdSchema,
        value: projectOptionsSchema.nullable(),
      })
      .strict(),
    output: projectState,
  },
  machineExecutable: {
    input: z.object({ hostId: hostIdSchema }).strict(),
    output: machineState,
  },
  saveMachineExecutable: {
    input: z
      .object({ hostId: hostIdSchema, value: executableSchema.nullable() })
      .strict(),
    output: machineState,
  },
});
