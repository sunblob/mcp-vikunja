#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, configPath, PACKAGE_NAME, VERSION } from "./config.js";
import { makeClient } from "./client.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerRelationTools } from "./tools/relations.js";
import { registerKanbanTools } from "./tools/kanban.js";
import { registerUserTools } from "./tools/users.js";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "setup") {
  const { runSetup } = await import("./setup.js");
  await runSetup(rest);
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else {
  await runServer();
}

function printHelp(): void {
  console.log(`${PACKAGE_NAME} ${VERSION}

Usage:
  npx ${PACKAGE_NAME}                 start the MCP server (stdio)
  npx ${PACKAGE_NAME} setup           interactive configuration
  npx ${PACKAGE_NAME} setup --reset   delete stored configuration
  npx ${PACKAGE_NAME} setup --print   print MCP client config snippets

Configuration precedence:
  1. VIKUNJA_URL, VIKUNJA_API_TOKEN, VIKUNJA_ALLOW_DELETE env vars
  2. ${configPath()}
`);
}

async function runServer(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error(`No configuration found. Run: npx ${PACKAGE_NAME} setup`);
    console.error("(or set VIKUNJA_URL and VIKUNJA_API_TOKEN in the environment)");
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    console.error(`${PACKAGE_NAME} is an MCP stdio server and expects to be launched by an MCP client.`);
    console.error(`Run "npx ${PACKAGE_NAME} setup" to configure it, or "npx ${PACKAGE_NAME} --help".`);
    process.exit(1);
  }

  const vikunja = makeClient(config.url, config.token);
  const server = new McpServer({ name: "mcp-vikunja", version: VERSION });

  registerProjectTools(server, vikunja);
  registerTaskTools(server, vikunja, { allowDelete: config.allowDelete, defaultProjectId: config.defaultProjectId });
  registerCommentTools(server, vikunja, { allowDelete: config.allowDelete });
  registerAttachmentTools(server, vikunja, { allowDelete: config.allowDelete });
  registerRelationTools(server, vikunja);
  registerKanbanTools(server, vikunja);
  registerUserTools(server, vikunja);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `mcp-vikunja ${VERSION} connected (${config.url}, delete tools ${config.allowDelete ? "enabled" : "disabled"})`,
  );
}
