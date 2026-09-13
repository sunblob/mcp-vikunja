// Exercises MCP client auto-install against a throwaway HOME. tsdown builds src/install.ts into .build/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSelection, detectClients, hasEntry, installClient } from "../.build/install.js";

const KEY = "vikunja";
const PKG = "@fswap/mcp-vikunja@latest";

function sandbox(platform = "darwin", onPath = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-install-"));
  return {
    home,
    platform,
    appData: path.join(home, "AppData", "Roaming"),
    which: (cmd) => onPath.includes(cmd),
    run: () => {
      throw new Error("unexpected CLI call");
    },
  };
}

const read = (f) => fs.readFileSync(f, "utf8");
const write = (f, s) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};
const entry = (env) => ({ command: "npx", args: ["-y", PKG], ...(env ? { env } : {}) });

test("detectClients reports config dirs and CLIs that exist", () => {
  const env = sandbox("darwin", ["claude"]);
  fs.mkdirSync(path.join(env.home, ".cursor"));
  const found = Object.fromEntries(detectClients(env).map((c) => [c.id, c.detected]));
  assert.deepEqual(found, { "claude-code": true, "claude-desktop": false, cursor: true, codex: false });
});

test("defaultSelection skips Claude Code when Claude Desktop is present, since its Code tab loads that config too", () => {
  const env = sandbox("darwin", ["claude"]);
  fs.mkdirSync(path.join(env.home, "Library", "Application Support", "Claude"), { recursive: true });
  fs.mkdirSync(path.join(env.home, ".codex"));
  assert.deepEqual(defaultSelection(detectClients(env)), ["claude-desktop", "codex"]);
});

test("defaultSelection keeps Claude Code when it is the only Claude client found", () => {
  const env = sandbox("darwin", ["claude"]);
  assert.deepEqual(defaultSelection(detectClients(env)), ["claude-code"]);
});

test("Claude Desktop config path follows the platform", () => {
  const loc = (platform) => detectClients(sandbox(platform)).find((c) => c.id === "claude-desktop").location;
  assert.match(loc("darwin"), /Library[\\/]Application Support[\\/]Claude[\\/]claude_desktop_config\.json$/);
  assert.match(loc("win32"), /AppData[\\/]Roaming[\\/]Claude[\\/]claude_desktop_config\.json$/);
  assert.match(loc("linux"), /\.config[\\/]Claude[\\/]claude_desktop_config\.json$/);
});

test("Cursor: creates mcp.json when missing", () => {
  const env = sandbox();
  const file = path.join(env.home, ".cursor", "mcp.json");
  assert.equal(hasEntry("cursor", env), false);
  assert.deepEqual(installClient("cursor", {}, env), { status: "added", location: file });
  assert.deepEqual(JSON.parse(read(file)), { mcpServers: { [KEY]: entry() } });
  assert.equal(hasEntry("cursor", env), true);
  assert.equal(fs.existsSync(file + ".bak"), false, "nothing to back up for a new file");
});

test("Claude Desktop: merges into existing config, keeps other keys, backs up once", () => {
  const env = sandbox("darwin");
  const file = path.join(env.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const original = JSON.stringify({ globalShortcut: "Cmd+Space", mcpServers: { other: { command: "x" } } }, null, 2);
  write(file, original);

  assert.equal(installClient("claude-desktop", { VIKUNJA_API_TOKEN: "tk_..." }, env).status, "added");
  assert.deepEqual(JSON.parse(read(file)), {
    globalShortcut: "Cmd+Space",
    mcpServers: { other: { command: "x" }, [KEY]: entry({ VIKUNJA_API_TOKEN: "tk_..." }) },
  });
  assert.equal(read(file + ".bak"), original);

  installClient("claude-desktop", {}, env);
  assert.equal(read(file + ".bak"), original, "later installs keep the first backup");
});

test("JSON clients: replacing an existing entry reports replaced", () => {
  const env = sandbox();
  const file = path.join(env.home, ".cursor", "mcp.json");
  write(file, JSON.stringify({ mcpServers: { [KEY]: { command: "old" } } }));
  assert.equal(hasEntry("cursor", env), true);
  assert.equal(installClient("cursor", {}, env).status, "replaced");
  assert.deepEqual(JSON.parse(read(file)).mcpServers[KEY], entry());
});

test("JSON clients: unparseable config is left untouched", () => {
  const env = sandbox();
  const file = path.join(env.home, ".cursor", "mcp.json");
  write(file, "{ not json");
  assert.throws(() => installClient("cursor", {}, env), /Could not parse/);
  assert.equal(read(file), "{ not json");
  assert.equal(fs.existsSync(file + ".bak"), false);
});

test("Codex: creates config.toml when missing", () => {
  const env = sandbox();
  const file = path.join(env.home, ".codex", "config.toml");
  assert.equal(hasEntry("codex", env), false);
  assert.deepEqual(installClient("codex", {}, env), { status: "added", location: file });
  assert.equal(read(file), `[mcp_servers.${KEY}]\ncommand = "npx"\nargs = ["-y", "${PKG}"]\n`);
});

test("Codex: replaces existing sections and leaves the rest of config.toml alone", () => {
  const env = sandbox();
  const file = path.join(env.home, ".codex", "config.toml");
  write(
    file,
    [
      'model = "gpt-5"',
      "",
      `[mcp_servers.${KEY}]`,
      'command = "old"',
      "",
      `[mcp_servers.${KEY}.env]`,
      'VIKUNJA_URL = "http://old"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      `[mcp_servers.${KEY}x]`,
      'command = "similar name"',
      "",
    ].join("\n"),
  );

  assert.equal(hasEntry("codex", env), true);
  assert.equal(installClient("codex", { VIKUNJA_URL: "https://try.vikunja.io" }, env).status, "replaced");
  assert.equal(
    read(file),
    [
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      `[mcp_servers.${KEY}x]`,
      'command = "similar name"',
      "",
      `[mcp_servers.${KEY}]`,
      'command = "npx"',
      `args = ["-y", "${PKG}"]`,
      `[mcp_servers.${KEY}.env]`,
      'VIKUNJA_URL = "https://try.vikunja.io"',
      "",
    ].join("\n"),
  );
  assert.ok(fs.existsSync(file + ".bak"));
});

test("Claude Code: replaces through the claude CLI at user scope", () => {
  const calls = [];
  const env = {
    ...sandbox("darwin", ["claude"]),
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { ok: true, output: "" };
    },
  };
  assert.equal(hasEntry("claude-code", env), true);
  const result = installClient("claude-code", { VIKUNJA_URL: "https://try.vikunja.io" }, env);
  assert.deepEqual(result, { status: "replaced", location: "user scope via claude mcp" });
  assert.deepEqual(calls, [
    `claude mcp get ${KEY}`,
    `claude mcp get ${KEY}`,
    `claude mcp remove ${KEY} -s user`,
    `claude mcp add ${KEY} -s user -e VIKUNJA_URL=https://try.vikunja.io -- npx -y ${PKG}`,
  ]);
});

test("Claude Code: CLI failures surface as errors", () => {
  const env = {
    ...sandbox("darwin", ["claude"]),
    run: (_cmd, args) => (args[1] === "get" ? { ok: false, output: "" } : { ok: false, output: "boom" }),
  };
  assert.throws(() => installClient("claude-code", {}, env), /boom/);
});
