import { z } from "zod";

export const executableSchema = z.union([
  z.literal(""),
  z
    .string()
    .startsWith("/")
    .refine((value) => !value.includes("\0")),
]);
export const branchNameSchema = z
  .string()
  .min(1)
  .refine(
    (branch) =>
      branch !== "@" &&
      branch !== "HEAD" &&
      !branch.startsWith("-") &&
      !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      !branch.endsWith(".") &&
      branch
        .split("/")
        .every(
          (part) =>
            part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
        ),
    "Choose a valid Git branch name.",
  );
export const startingBranchSchema = branchNameSchema.refine(
  (branch) => branch.startsWith("origin/") && branch.length > "origin/".length,
  "Use an origin branch, such as origin/main or origin/release/next.",
);
export const projectOptionsSchema = z
  .object({
    fetchBeforeCreate: z.boolean(),
    startingBranch: startingBranchSchema,
    reuseDependencies: z.boolean(),
  })
  .strict();
export const copyOptionsSchema = projectOptionsSchema.extend({
  startingBranch: branchNameSchema,
});
export type ProjectOptions = z.infer<typeof projectOptionsSchema>;
export const defaultProjectOptions: ProjectOptions = {
  fetchBeforeCreate: true,
  startingBranch: "origin/main",
  reuseDependencies: true,
};
