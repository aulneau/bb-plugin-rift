import fs from "node:fs/promises";
export async function exists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
export async function writeJson(file: string, value: object) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
