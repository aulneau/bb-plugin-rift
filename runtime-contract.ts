import { z } from "zod";
import { executableSchema } from "./options.js";

export const runtimeActionSchema = z.enum([
  "status",
  "check",
  "install",
  "update",
  "maintain",
]);
export type RuntimeAction = z.infer<typeof runtimeActionSchema>;
export const runtimeInstallationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      source: z.enum(["managed", "existing", "override"]),
      binaryPath: executableSchema,
      version: z.string().nullable(),
    })
    .strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z.object({ status: z.literal("failed"), message: z.string() }).strict(),
]);
export type RuntimeInstallation = z.infer<typeof runtimeInstallationSchema>;
export const runtimeStateSchema = z
  .object({
    installation: runtimeInstallationSchema,
    latestVersion: z.string().nullable(),
    checkedAt: z.number().nullable(),
    updateError: z.string().nullable(),
  })
  .strict();
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
