import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { ok, guard, summarizeUser, type User } from "./_shared.js";

export function registerUserTools(server: McpServer, vikunja: VikunjaClient): void {
  server.registerTool(
    "get_current_user",
    {
      title: "Get current user",
      description: "Return the authenticated user's id, username and name (e.g. to assign a task to yourself).",
      inputSchema: {},
    },
    guard(async () => ok(summarizeUser(await vikunja.get<User>("/user")))),
  );

  server.registerTool(
    "find_users",
    {
      title: "Find users",
      description:
        "Find user ids for assigning tasks. With projectId, lists users who have access to that project " +
        "(only they can be assigned); search narrows by username or name.",
      inputSchema: {
        search: z.string().optional().describe("Username, name or full email"),
        projectId: z.number().int().optional().describe("Only users with access to this project"),
      },
    },
    guard(async ({ search, projectId }) => {
      if (projectId == null && !search) throw new Error("Pass search, projectId, or both.");
      const path = projectId != null ? `/projects/${projectId}/projectusers` : "/users";
      const data = await vikunja.get<User[] | null>(path, { s: search });
      return ok((data ?? []).map((u) => summarizeUser(u)));
    }),
  );
}
