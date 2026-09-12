import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { runtimeActionSchema, runtimeStateSchema } from "./runtime-contract.js";
import {
  executableSchema,
  projectOptionsSchema,
  startingBranchSchema,
} from "./options.js";

export const idSchema = z.string().uuid();
export const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
export const pathSchema = z
  .string()
  .startsWith("/")
  .refine((value) => !value.includes("\0"));
export const failureSchema = z
  .object({ status: z.literal("failed"), message: z.string() })
  .strict();
export const copySchema = z
  .object({
    id: idSchema,
    name: nameSchema,
    sourcePath: pathSchema,
    path: pathSchema,
    branch: z.string(),
    startingBranch: startingBranchSchema,
    startingCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    createdAt: z.number(),
  })
  .strict();
export type RiftCopy = z.infer<typeof copySchema>;
export const hostContract = defineRpcContract({
  runtime: {
    input: z
      .object({ binaryPath: executableSchema, action: runtimeActionSchema })
      .strict(),
    output: runtimeStateSchema,
  },
  create: {
    input: z
      .object({
        id: idSchema,
        name: nameSchema,
        sourcePath: pathSchema,
        binaryPath: executableSchema,
        options: projectOptionsSchema,
        branchName: z
          .string()
          .min(1)
          .refine((value) => !value.includes("\0")),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("created"), copy: copySchema }).strict(),
      z.object({ status: z.literal("busy"), message: z.string() }).strict(),
      failureSchema,
    ]),
  },
  inspect: {
    input: z
      .object({ binaryPath: executableSchema, sourcePath: pathSchema })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ready"), platform: z.string() }).strict(),
      failureSchema,
    ]),
  },
  remove: {
    input: z.object({ id: idSchema, binaryPath: executableSchema }).strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("removed"),
          retainedPath: pathSchema.nullable(),
        })
        .strict(),
      failureSchema,
    ]),
  },
});
