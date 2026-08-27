import crypto from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

export type ArtifactKind = "image" | "video" | "voice";

export type ArtifactMimeType =
  | "image/png"
  | "image/jpeg"
  | "video/mp4"
  | "audio/silk"
  | "audio/mpeg"
  | "audio/wav"
  | "audio/ogg";

export interface PreparedArtifact {
  data: Buffer;
  digest: string;
  fileName: string;
  kind: ArtifactKind;
  mimeType: ArtifactMimeType;
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
    const mediaType = detectArtifactType(data);
    if (!mediaType) {
      throw new Error(
        "Unsupported artifact type; send_artifact accepts PNG/JPEG images, " +
        "MP4 video, and SILK/MP3/WAV/OGG voice audio",
      );
    }
    return {
      data,
      digest: crypto.createHash("sha256").update(data).digest("hex"),
      fileName: path.basename(resolved),
      ...mediaType,
    };
  } finally {
    await handle.close();
  }
}

function detectArtifactType(
  data: Buffer,
): Pick<PreparedArtifact, "kind" | "mimeType"> | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (isMp4(data)) {
    return { kind: "video", mimeType: "video/mp4" };
  }
  if (isSilk(data)) {
    return { kind: "voice", mimeType: "audio/silk" };
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WAVE"
  ) {
    return { kind: "voice", mimeType: "audio/wav" };
  }
  if (isOggAudio(data)) {
    return { kind: "voice", mimeType: "audio/ogg" };
  }
  if (isMp3(data)) {
    return { kind: "voice", mimeType: "audio/mpeg" };
  }
  return undefined;
}

function isOggAudio(data: Buffer): boolean {
  if (data.length < 12 || data.toString("ascii", 0, 4) !== "OggS") {
    return false;
  }
  return [
    Buffer.from("OpusHead"),
    Buffer.from("\x01vorbis", "binary"),
    Buffer.from("Speex   "),
  ].some((marker) => data.indexOf(marker) >= 0);
}

function isMp4(data: Buffer): boolean {
  if (data.length < 16 || data.toString("ascii", 4, 8) !== "ftyp") {
    return false;
  }
  const boxSize = data.readUInt32BE(0);
  if (boxSize < 16 || boxSize > data.length) return false;

  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    const brand = data.toString("ascii", offset, offset + 4);
    if (
      brand === "isom" ||
      brand === "avc1" ||
      brand === "dash" ||
      brand === "M4V " ||
      brand === "MSNV" ||
      /^iso[2-9]$/.test(brand) ||
      /^mp4[12]$/.test(brand)
    ) {
      return true;
    }
  }
  return false;
}

function isSilk(data: Buffer): boolean {
  const header = "#!SILK_V3";
  return (
    data.toString("ascii", 0, header.length) === header ||
    (
      data[0] === 0x02 &&
      data.toString("ascii", 1, header.length + 1) === header
    )
  );
}

function isMp3(data: Buffer): boolean {
  if (data.length >= 3 && data.toString("ascii", 0, 3) === "ID3") {
    return true;
  }
  if (data.length < 4 || data[0] !== 0xff || (data[1]! & 0xe0) !== 0xe0) {
    return false;
  }
  const version = data[1]! & 0x18;
  const layer = data[1]! & 0x06;
  const bitrate = data[2]! >> 4;
  const sampleRate = (data[2]! >> 2) & 0x03;
  return (
    version !== 0x08 &&
    layer !== 0 &&
    bitrate !== 0 &&
    bitrate !== 0x0f &&
    sampleRate !== 0x03
  );
}
