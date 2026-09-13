import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SERVER_KEY, SERVER_COMMAND, SERVER_ARGS, serverEntry, tomlSnippet, type MissingEnv } from "./snippets.js";

export type ClientId = "claude-code" | "claude-desktop" | "cursor" | "codex";

export interface ClientTarget {
  id: ClientId;
  label: string;
  detected: boolean;
  /** Config file written, or a description for CLI-managed clients. */
  location: string;
  /** Where the client shows up, when the label alone is ambiguous. */
  hint?: string;
}

export interface InstallResult {
  status: "added" | "replaced";
  location: string;
}

/** Everything that touches the host, injectable so tests can point it at a temp HOME. */
export interface InstallEnv {
  home: string;
  platform: NodeJS.Platform;
  appData: string | undefined;
  which: (cmd: string) => boolean;
  run: (cmd: string, args: string[]) => { ok: boolean; output: string };
}

function onPath(cmd: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, cmd + ext))));
}

function runCommand(cmd: string, args: string[]): { ok: boolean; output: string } {
  // npm-installed CLIs are .cmd shims on Windows, which need a shell to launch.
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}`.trim() };
}

const hostEnv: InstallEnv = {
  home: os.homedir(),
  platform: process.platform,
  appData: process.env.APPDATA,
  which: onPath,
  run: runCommand,
};

function claudeDesktopConfig(env: InstallEnv): string {
  if (env.platform === "darwin") {
    return path.join(env.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (env.platform === "win32") {
    return path.join(env.appData ?? path.join(env.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return path.join(env.home, ".config", "Claude", "claude_desktop_config.json");
}

const cursorConfig = (env: InstallEnv) => path.join(env.home, ".cursor", "mcp.json");
const codexConfig = (env: InstallEnv) => path.join(env.home, ".codex", "config.toml");

const CLAUDE_CODE_LOCATION = "user scope via claude mcp";

export function detectClients(env: InstallEnv = hostEnv): ClientTarget[] {
  const dirExists = (file: string) => fs.existsSync(path.dirname(file));
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      detected: env.which("claude"),
      location: CLAUDE_CODE_LOCATION,
      hint: "terminal / IDE",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      detected: dirExists(claudeDesktopConfig(env)),
      location: claudeDesktopConfig(env),
      hint: "chat + Code tab",
    },
    { id: "cursor", label: "Cursor", detected: dirExists(cursorConfig(env)), location: cursorConfig(env) },
    {
      id: "codex",
      label: "Codex",
      detected: dirExists(codexConfig(env)) || env.which("codex"),
      location: codexConfig(env),
    },
  ];
}

/**
 * Detected clients to pre-select. Claude Code is left out when Claude Desktop is present: the desktop
 * app's Code tab also loads claude_desktop_config.json, so selecting both would register the server twice there.
 */
export function defaultSelection(clients: ClientTarget[]): ClientId[] {
  const desktopFound = clients.some((c) => c.id === "claude-desktop" && c.detected);
  return clients.filter((c) => c.detected && !(desktopFound && c.id === "claude-code")).map((c) => c.id);
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Writes `content`, keeping a copy of the original the first time an existing file is changed. */
function writeWithBackup(file: string, original: string | null, content: string): void {
  if (original !== null && !fs.existsSync(`${file}.bak`)) fs.writeFileSync(`${file}.bak`, original);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// --- JSON clients (Claude Desktop, Cursor) ---

type JsonConfig = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

function parseJsonConfig(file: string, text: string | null): JsonConfig {
  if (text === null || text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonConfig;
  } catch {
    // fall through
  }
  throw new Error(`Could not parse ${file}; left it unchanged`);
}

function jsonHasEntry(file: string): boolean {
  return Boolean(parseJsonConfig(file, readIfExists(file)).mcpServers?.[SERVER_KEY]);
}

function jsonInstall(file: string, missing: MissingEnv): InstallResult {
  const original = readIfExists(file);
  const config = parseJsonConfig(file, original);
  const replaced = Boolean(config.mcpServers?.[SERVER_KEY]);
  config.mcpServers = { ...config.mcpServers, [SERVER_KEY]: serverEntry(missing) };
  writeWithBackup(file, original, JSON.stringify(config, null, 2) + "\n");
  return { status: replaced ? "replaced" : "added", location: file };
}

// --- Codex (TOML, edited as text to avoid a TOML dependency) ---

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Matches [mcp_servers.<key>], [mcp_servers."<key>"] and their sub-tables such as [mcp_servers.<key>.env].
const ownHeader = new RegExp(`^\\s*\\[\\s*mcp_servers\\.("?)${escapeRe(SERVER_KEY)}\\1\\s*(\\]|\\.)`);
const anyHeader = /^\s*\[/;

function tomlHasEntry(text: string | null): boolean {
  return text !== null && text.split("\n").some((line) => ownHeader.test(line));
}

function tomlWithoutEntry(text: string): string {
  let inOwnSection = false;
  return text
    .split("\n")
    .filter((line) => {
      if (anyHeader.test(line)) inOwnSection = ownHeader.test(line);
      return !inOwnSection;
    })
    .join("\n");
}

function codexInstall(file: string, missing: MissingEnv): InstallResult {
  const original = readIfExists(file);
  const rest = original === null ? "" : tomlWithoutEntry(original).trimEnd();
  const content = (rest ? `${rest}\n\n` : "") + tomlSnippet(missing) + "\n";
  writeWithBackup(file, original, content);
  return { status: tomlHasEntry(original) ? "replaced" : "added", location: file };
}

// --- Claude Code (via its CLI, which owns ~/.claude.json) ---

function claude(env: InstallEnv, args: string[]): void {
  const r = env.run("claude", args);
  if (!r.ok) throw new Error(`claude ${args.join(" ")} failed${r.output ? `: ${r.output}` : ""}`);
}

function claudeCodeInstall(env: InstallEnv, missing: MissingEnv): InstallResult {
  const replaced = hasEntry("claude-code", env);
  if (replaced) claude(env, ["mcp", "remove", SERVER_KEY, "-s", "user"]);
  const envArgs = Object.entries(missing).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  claude(env, ["mcp", "add", SERVER_KEY, "-s", "user", ...envArgs, "--", SERVER_COMMAND, ...SERVER_ARGS]);
  return { status: replaced ? "replaced" : "added", location: CLAUDE_CODE_LOCATION };
}

/** Whether the client already has a server registered under SERVER_KEY. Throws if its config is unreadable. */
export function hasEntry(id: ClientId, env: InstallEnv = hostEnv): boolean {
  switch (id) {
    case "claude-code":
      return env.run("claude", ["mcp", "get", SERVER_KEY]).ok;
    case "claude-desktop":
      return jsonHasEntry(claudeDesktopConfig(env));
    case "cursor":
      return jsonHasEntry(cursorConfig(env));
    case "codex":
      return tomlHasEntry(readIfExists(codexConfig(env)));
  }
}

/** Adds (or overwrites) this server in the client's config. Throws with a readable message on failure. */
export function installClient(id: ClientId, missing: MissingEnv, env: InstallEnv = hostEnv): InstallResult {
  switch (id) {
    case "claude-code":
      return claudeCodeInstall(env, missing);
    case "claude-desktop":
      return jsonInstall(claudeDesktopConfig(env), missing);
    case "cursor":
      return jsonInstall(cursorConfig(env), missing);
    case "codex":
      return codexInstall(codexConfig(env), missing);
  }
}
