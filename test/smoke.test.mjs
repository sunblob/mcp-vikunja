// Spawns the built server over stdio with fake credentials and checks the tool list + delete gating.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

async function listTools(env) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write(
    rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } }),
  );
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(rpc(2, "tools/list"));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = out.split("\n").find((l) => l.includes('"id":2'));
    if (line) {
      child.kill();
      return JSON.parse(line).result.tools.map((t) => t.name).sort();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error("timed out waiting for tools/list; stdout was: " + out);
}

const base = { VIKUNJA_URL: "http://127.0.0.1:9", VIKUNJA_API_TOKEN: "fake" };

const tools = await listTools({ ...base, VIKUNJA_ALLOW_DELETE: "" });
assert.deepEqual(tools, [
  "complete_task",
  "create_label",
  "create_project",
  "create_task",
  "get_project",
  "get_task",
  "list_labels",
  "list_projects",
  "list_tasks",
  "update_task",
]);

const withDelete = await listTools({ ...base, VIKUNJA_ALLOW_DELETE: "true" });
assert.ok(withDelete.includes("delete_task"), "delete_task should appear with VIKUNJA_ALLOW_DELETE=true");

console.log(`ok - ${tools.length} tools listed, delete gating works`);
