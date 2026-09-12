import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const releaseSchema = z
  .object({
    version: versionSchema,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type Release = z.infer<typeof releaseSchema>;
const metadataSchema = z.object({
  name: z.literal("rift-snapshot"),
  version: versionSchema,
  dist: z.object({ integrity: releaseSchema.shape.integrity }),
});
const registry = "https://registry.npmjs.org/rift-snapshot";
const limit = 64 * 1024 * 1024;

export async function fetchBytes(
  url: string,
  maximum: number,
  signal: AbortSignal,
) {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok)
    throw new Error(`Rift download failed: HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("Rift download exceeded its size limit.");
  }
  if (response.body === null) throw new Error("Rift download was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new Error("Rift download exceeded its size limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function latestRelease(signal: AbortSignal): Promise<Release> {
  const bytes = await fetchBytes(
    `${registry}/latest`,
    1024 * 1024,
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  );
  const metadata = metadataSchema.parse(JSON.parse(bytes.toString("utf8")));
  return { version: metadata.version, integrity: metadata.dist.integrity };
}

export async function downloadRelease(
  release: Release,
  platform: string,
  directory: string,
  signal: AbortSignal,
  fetchArchive: typeof fetchBytes = fetchBytes,
) {
  const bytes = await fetchArchive(
    `${registry}/-/rift-snapshot-${release.version}.tgz`,
    limit,
    signal,
  );
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== release.integrity)
    throw new Error("Rift download integrity verification failed.");
  const archive = path.join(directory, "package.tgz");
  await fs.writeFile(archive, bytes, { mode: 0o600 });
  await extractExecutable(
    archive,
    `package/prebuilds/${platform}/rift`,
    path.join(directory, "rift"),
    signal,
  );
  await fs.unlink(archive);
  await fs.chmod(path.join(directory, "rift"), 0o700);
}

export async function extractExecutable(
  archive: string,
  member: string,
  destination: string,
  signal: AbortSignal,
) {
  const child = spawn("/usr/bin/tar", ["-xOzf", archive, member], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString("utf8")).slice(-4000);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(errors.trim() || "Could not extract Rift executable."),
          ),
    );
  });
  const abort = () => {
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let size = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(
        size > limit
          ? new Error("Rift executable exceeded its size limit.")
          : null,
        chunk,
      );
    },
  });
  const copied = pipeline(
    child.stdout,
    bounded,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  try {
    await Promise.all([closed, copied]);
    if (size === 0) throw new Error("Rift executable was empty.");
  } finally {
    abort();
    await Promise.allSettled([closed, copied]);
    signal.removeEventListener("abort", abort);
  }
}
