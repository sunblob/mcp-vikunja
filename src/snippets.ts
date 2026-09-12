import { PACKAGE_NAME } from "./config.js";

export const SERVER_KEY = "vikunja";
export const ENV_URL = "VIKUNJA_URL";
export const ENV_TOKEN = "VIKUNJA_API_TOKEN";
export const ENV_ALLOW_DELETE = "VIKUNJA_ALLOW_DELETE";

/** Env vars the user still has to provide because they were skipped in setup. */
export type MissingEnv = Partial<Record<typeof ENV_URL | typeof ENV_TOKEN, string>>;

function jsonSnippet(missing: MissingEnv): string {
  const server: Record<string, unknown> = { command: "npx", args: ["-y", `${PACKAGE_NAME}@latest`] };
  if (Object.keys(missing).length > 0) server.env = missing;
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: server } }, null, 2);
}

function tomlSnippet(missing: MissingEnv): string {
  const lines = [`[mcp_servers.${SERVER_KEY}]`, 'command = "npx"', `args = ["-y", "${PACKAGE_NAME}@latest"]`];
  if (Object.keys(missing).length > 0) {
    lines.push(`[mcp_servers.${SERVER_KEY}.env]`);
    for (const [k, v] of Object.entries(missing)) lines.push(`${k} = "${v}"`);
  }
  return lines.join("\n");
}

function claudeCodeSnippet(missing: MissingEnv): string {
  const env = Object.entries(missing)
    .map(([k, v]) => `-e ${k}=${v} `)
    .join("");
  return `claude mcp add ${SERVER_KEY} ${env}-- npx -y ${PACKAGE_NAME}@latest`;
}

export interface Snippet {
  title: string;
  body: string;
}

export function clientSnippets(missing: MissingEnv = {}): Snippet[] {
  return [
    { title: "Claude Desktop — claude_desktop_config.json", body: jsonSnippet(missing) },
    { title: "Cursor — ~/.cursor/mcp.json (or <project>/.cursor/mcp.json)", body: jsonSnippet(missing) },
    { title: "Codex — ~/.codex/config.toml", body: tomlSnippet(missing) },
    { title: "Claude Code", body: claudeCodeSnippet(missing) },
  ];
}
