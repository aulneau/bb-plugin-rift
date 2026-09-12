import { z } from "zod";

export const executableSchema = z.union([
  z.literal(""),
  z
    .string()
    .startsWith("/")
    .refine((value) => !value.includes("\0")),
]);
export const startingBranchSchema = z
  .string()
  .startsWith("origin/")
  .refine((value) => {
    const branch = value.slice("origin/".length);
    return (
      branch.length > 0 &&
      !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      !branch.endsWith(".") &&
      branch
        .split("/")
        .every(
          (part) =>
            part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
        )
    );
  }, "Use an origin branch, such as origin/main or origin/release/next.");
export const projectOptionsSchema = z
  .object({
    fetchBeforeCreate: z.boolean(),
    startingBranch: startingBranchSchema,
    reuseDependencies: z.boolean(),
  })
  .strict();
export type ProjectOptions = z.infer<typeof projectOptionsSchema>;
export const defaultProjectOptions: ProjectOptions = {
  fetchBeforeCreate: true,
  startingBranch: "origin/main",
  reuseDependencies: true,
};
