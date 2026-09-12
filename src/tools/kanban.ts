import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { ok, guard } from "./_shared.js";

interface ProjectView {
  id: number;
  title: string;
  project_id: number;
  // "kanban" on current Vikunja; older versions used numeric kinds (3 = kanban).
  view_kind: string | number;
  default_bucket_id?: number;
  done_bucket_id?: number;
}

interface Bucket {
  id: number;
  title: string;
  project_view_id: number;
  limit?: number;
}

async function kanbanViews(vikunja: VikunjaClient, projectId: number): Promise<ProjectView[]> {
  const views = await vikunja.get<ProjectView[] | null>(`/projects/${projectId}/views`);
  return (views ?? []).filter((v) => v.view_kind === "kanban" || v.view_kind === 3);
}

async function viewBuckets(vikunja: VikunjaClient, projectId: number, viewId: number): Promise<Bucket[]> {
  return (await vikunja.get<Bucket[] | null>(`/projects/${projectId}/views/${viewId}/buckets`)) ?? [];
}

export function registerKanbanTools(server: McpServer, vikunja: VikunjaClient): void {
  server.registerTool(
    "list_kanban_buckets",
    {
      title: "List kanban buckets",
      description: "List a project's kanban views and their buckets (columns), with ids for move_task_to_bucket.",
      inputSchema: { projectId: z.number().int().describe("Project id") },
    },
    guard(async ({ projectId }) => {
      const views = await kanbanViews(vikunja, projectId);
      const result = await Promise.all(
        views.map(async (v) => ({
          viewId: v.id,
          title: v.title,
          defaultBucketId: v.default_bucket_id || null,
          doneBucketId: v.done_bucket_id || null,
          buckets: (await viewBuckets(vikunja, projectId, v.id)).map((b) => ({ id: b.id, title: b.title, limit: b.limit || null })),
        })),
      );
      return ok(result);
    }),
  );

  server.registerTool(
    "move_task_to_bucket",
    {
      title: "Move task to kanban bucket",
      description:
        "Move a task into a kanban bucket (column) of its project. Moving into the view's done bucket marks the task done. " +
        "To move a task to another project use update_task with projectId.",
      inputSchema: {
        taskId: z.number().int().describe("Task id"),
        bucketId: z.number().int().describe("Target bucket id (list_kanban_buckets)"),
        viewId: z.number().int().optional().describe("Kanban view id; looked up from the bucket when omitted"),
      },
    },
    guard(async ({ taskId, bucketId, viewId }) => {
      const task = await vikunja.get<{ project_id: number }>(`/tasks/${taskId}`);
      const projectId = task.project_id;
      let view = viewId;
      if (view == null) {
        for (const v of await kanbanViews(vikunja, projectId)) {
          if ((await viewBuckets(vikunja, projectId, v.id)).some((b) => b.id === bucketId)) {
            view = v.id;
            break;
          }
        }
        if (view == null) {
          throw new Error(`Bucket ${bucketId} is not in any kanban view of project ${projectId}; see list_kanban_buckets.`);
        }
      }
      await vikunja.post(`/projects/${projectId}/views/${view}/buckets/${bucketId}/tasks`, {
        task_id: taskId,
        bucket_id: bucketId,
        project_view_id: view,
      });
      return ok({ taskId, projectId, viewId: view, bucketId, moved: true });
    }),
  );
}
