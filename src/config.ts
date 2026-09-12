import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import envPaths from "env-paths";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;

const paths = envPaths("mcp-vikunja", { suffix: "" });

export interface StoredConfig {
  url?: string;
  token?: string;
  defaultProjectId?: number | null;
  allowDelete?: boolean;
}

export interface RuntimeConfig {
  url: string;
  token: string;
  allowDelete: boolean;
  defaultProjectId: number | null;
}

export function configPath(): string {
  return path.join(paths.config, "config.json");
}

function truthy(v: string | undefined): boolean {
  return v != null && /^(1|true|yes|on)$/i.test(v.trim());
}

export function readConfigFile(): StoredConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as StoredConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error(`Warning: could not read ${configPath()}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve runtime configuration.
 * Precedence: environment variables > config file written by `setup`.
 * Returns null when neither provides url + token.
 */
export function loadConfig(): RuntimeConfig | null {
  const env = process.env;
  const file = readConfigFile() ?? {};

  const url = env.VIKUNJA_URL || file.url;
  const token = env.VIKUNJA_API_TOKEN || file.token;
  if (!url || !token) return null;

  const deleteEnv = env.VIKUNJA_ALLOW_DELETE ?? env.ALLOW_DELETE;
  const allowDelete = deleteEnv != null ? truthy(deleteEnv) : Boolean(file.allowDelete);

  const envProject = env.VIKUNJA_DEFAULT_PROJECT_ID ? Number(env.VIKUNJA_DEFAULT_PROJECT_ID) : NaN;
  const defaultProjectId = Number.isFinite(envProject) ? envProject : (file.defaultProjectId ?? null);

  return {
    url: url.replace(/\/+$/, ""),
    token,
    allowDelete,
    defaultProjectId,
  };
}

export function saveConfig(config: StoredConfig): string {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function deleteConfig(): boolean {
  try {
    fs.unlinkSync(configPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
