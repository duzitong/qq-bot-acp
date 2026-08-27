import fs from "node:fs/promises";
import path from "node:path";
import type { BotPaths } from "./paths.js";
import { parseConfig, type BotConfig } from "./schema.js";

export interface StartupConfig {
  config: BotConfig;
  source: "current" | "proven";
  currentError?: Error;
}

export class ConfigStore {
  constructor(readonly paths: BotPaths) {}

  async exists(): Promise<boolean> {
    return fileExists(this.paths.config);
  }

  async initialize(config: BotConfig): Promise<void> {
    if (await this.exists()) {
      throw new Error(`Configuration already exists: ${this.paths.config}`);
    }
    await this.write(config);
  }

  async read(): Promise<BotConfig> {
    return readConfigFile(this.paths.config);
  }

  async write(config: BotConfig): Promise<void> {
    await atomicWriteJson(this.paths.config, parseConfig(config));
  }

  async markProven(config: BotConfig): Promise<void> {
    await atomicWriteJson(this.paths.provenConfig, parseConfig(config));
  }

  async readProven(): Promise<BotConfig> {
    return readConfigFile(this.paths.provenConfig);
  }

  async loadForStartup(
    prove: (config: BotConfig) => Promise<void>,
  ): Promise<StartupConfig> {
    let current: BotConfig;
    try {
      current = await this.read();
      await prove(current);
      return { config: current, source: "current" };
    } catch (error) {
      const currentError = normalizeError(error);
      if (!(await fileExists(this.paths.provenConfig))) throw currentError;

      await this.archiveFailedCurrent();
      const proven = await readConfigFile(this.paths.provenConfig);
      await prove(proven);
      await this.write(proven);
      return { config: proven, source: "proven", currentError };
    }
  }

  async bootstrapAdmins(admins: string[]): Promise<BotConfig> {
    const unique = [...new Set(admins.map((entry) => entry.trim()).filter(Boolean))];
    if (unique.length === 0) return this.read();

    const config = await this.read();
    if (config.access.admins.length > 0) {
      throw new Error(
        "--admin-openid is bootstrap-only and cannot replace configured administrators",
      );
    }
    const updated = parseConfig({
      ...config,
      access: { ...config.access, admins: unique },
    });
    await this.write(updated);
    return updated;
  }

  private async archiveFailedCurrent(): Promise<void> {
    try {
      const raw = await fs.readFile(this.paths.config, "utf8");
      await atomicWriteText(this.paths.failedConfig, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function readConfigFile(file: string): Promise<BotConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Configuration not found: ${file}`);
    }
    throw error;
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid configuration ${file}: ${normalizeError(error).message}`, {
      cause: error,
    });
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, value, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
