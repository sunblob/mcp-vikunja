import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { ok, guard } from "./_shared.js";

const RELATION_KINDS = [
  "subtask",
  "parenttask",
  "related",
  "duplicateof",
  "duplicates",
  "blocking",
  "blocked",
  "precedes",
  "follows",
  "copiedfrom",
  "copiedto",
] as const;

const relationInput = {
  taskId: z.number().int().describe("The base task"),
  kind: z
    .enum(RELATION_KINDS)
    .describe(
      "What otherTaskId is to taskId: subtask = other is a subtask of taskId, parenttask = other is its parent, " +
        "blocking = taskId blocks other, blocked = taskId is blocked by other, precedes / follows, related, " +
        "duplicateof / duplicates, copiedfrom / copiedto. Vikunja creates the inverse relation automatically.",
    ),
  otherTaskId: z.number().int().describe("The related task"),
};

export function registerRelationTools(server: McpServer, vikunja: VikunjaClient): void {
  server.registerTool(
    "add_task_relation",
    {
      title: "Add task relation",
      description: "Relate two tasks (subtask, parent, blocking, related, …). See get_task relatedTasks for current ones.",
      inputSchema: relationInput,
    },
    guard(async ({ taskId, kind, otherTaskId }) => {
      await vikunja.put(`/tasks/${taskId}/relations`, {
        task_id: taskId,
        other_task_id: otherTaskId,
        relation_kind: kind,
      });
      return ok({ taskId, kind, otherTaskId, related: true });
    }),
  );

  server.registerTool(
    "remove_task_relation",
    {
      title: "Remove task relation",
      description: "Remove a relation between two tasks (the inverse relation is removed too).",
      inputSchema: relationInput,
    },
    guard(async ({ taskId, kind, otherTaskId }) => {
      await vikunja.del(`/tasks/${taskId}/relations/${kind}/${otherTaskId}`);
      return ok({ taskId, kind, otherTaskId, related: false });
    }),
  );
}
