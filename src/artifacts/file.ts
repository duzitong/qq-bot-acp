import crypto from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

export interface PreparedArtifact {
  data: Buffer;
  digest: string;
  fileName: string;
  mimeType: "image/png" | "image/jpeg";
}

export async function prepareArtifact(
  cwd: string,
  requestedPath: string,
): Promise<PreparedArtifact> {
  const root = await fs.promises.realpath(cwd);
  const resolved = await fs.promises.realpath(path.resolve(root, requestedPath));
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Artifact path must be inside the agent working directory");
  }

  const handle = await fs.promises.open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Artifact path must refer to a regular file");
    if (stat.size === 0) throw new Error("Artifact file is empty");
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `Artifact exceeds the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MiB upload limit`,
      );
    }

    const data = await handle.readFile();
    if (data.length === 0) throw new Error("Artifact file is empty");
    if (data.length > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `Artifact exceeds the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MiB upload limit`,
      );
    }
    const mimeType = detectImageMimeType(data);
    if (!mimeType) {
      throw new Error(
        "Unsupported artifact type; send_artifact currently accepts PNG and JPEG images",
      );
    }
    return {
      data,
      digest: crypto.createHash("sha256").update(data).digest("hex"),
      fileName: path.basename(resolved),
      mimeType,
    };
  } finally {
    await handle.close();
  }
}

function detectImageMimeType(
  data: Buffer,
): PreparedArtifact["mimeType"] | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return undefined;
}
