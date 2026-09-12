import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeDate, type VikunjaClient } from "../client.js";
import { ok, guard, stripUndefined } from "./_shared.js";

interface Label {
  id: number;
  title: string;
  hex_color?: string;
  description?: string;
}

interface User {
  id: number;
  username: string;
  name?: string;
}

export interface Task {
  id: number;
  title: string;
  description?: string;
  done: boolean;
  done_at?: string;
  due_date?: string;
  start_date?: string;
  end_date?: string;
  priority?: number;
  percent_done?: number;
  project_id: number;
  labels?: Label[] | null;
  assignees?: User[] | null;
  created?: string;
  updated?: string;
  identifier?: string;
  repeat_after?: number;
  bucket_id?: number;
}

function summarizeTask(t: Task) {
  return {
    id: t.id,
    title: t.title,
    done: t.done,
    dueDate: normalizeDate(t.due_date),
    priority: t.priority ?? 0,
    projectId: t.project_id,
    identifier: t.identifier || null,
    labels: (t.labels ?? []).map((l) => l.title),
    assignees: (t.assignees ?? []).map((u) => u.username),
    updated: t.updated,
  };
}

function fullTask(t: Task) {
  return {
    ...summarizeTask(t),
    description: t.description || "",
    doneAt: normalizeDate(t.done_at),
    startDate: normalizeDate(t.start_date),
    endDate: normalizeDate(t.end_date),
    percentDone: t.percent_done ?? 0,
    repeatAfterSeconds: t.repeat_after || null,
    labels: (t.labels ?? []).map((l) => ({ id: l.id, title: l.title, color: l.hex_color || null })),
    assignees: (t.assignees ?? []).map((u) => ({ id: u.id, username: u.username, name: u.name || null })),
    created: t.created,
  };
}

const dateField = z
  .string()
  .datetime({ offset: true })
  .describe("RFC 3339 timestamp, e.g. 2026-09-15T17:00:00Z");

const priorityField = z
  .number()
  .int()
  .min(0)
  .max(5)
  .describe("0 = unset, 1 = low, 2 = medium, 3 = high, 4 = urgent, 5 = DO NOW");

/** Replace the task's labels with exactly `labelIds` (Vikunja has no single-call "set labels"). */
async function setLabels(vikunja: VikunjaClient, taskId: number, labelIds: number[]): Promise<void> {
  await vikunja.post(`/tasks/${taskId}/labels/bulk`, { labels: labelIds.map((id) => ({ id })) });
}

export interface TaskToolOptions {
  allowDelete?: boolean;
  defaultProjectId?: number | null;
}

export function registerTaskTools(
  server: McpServer,
  vikunja: VikunjaClient,
  { allowDelete = false, defaultProjectId = null }: TaskToolOptions = {},
): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks, across all projects or within one project. Returns id, title, done, due date, priority, label " +
        "names and assignee usernames (no descriptions — use get_task). By default only open tasks are returned. " +
        "Set assignedToMe=true for the current user's tasks. For advanced queries pass a raw Vikunja `filter` string " +
        "such as `done = false && due_date < now+7d`, `labels in 3, 5` or `assignees in alice`.",
      inputSchema: {
        projectId: z.number().int().optional().describe("Limit to this project (omit for all projects)"),
        includeDone: z.boolean().default(false).describe("Include completed tasks"),
        assignedToMe: z.boolean().default(false).describe("Only tasks assigned to the authenticated user"),
        search: z.string().optional().describe("Full-text search in title/description"),
        filter: z
          .string()
          .optional()
          .describe("Raw Vikunja filter expression; overrides includeDone. Fields: done, due_date, priority, labels, assignees, project"),
        sortBy: z.enum(["due_date", "priority", "id", "title", "done", "created", "updated"]).default("due_date"),
        orderBy: z.enum(["asc", "desc"]).default("asc"),
        page: z.number().int().min(1).default(1),
        perPage: z.number().int().min(1).max(100).default(50),
      },
    },
    guard(async ({ projectId, includeDone, assignedToMe, search, filter, sortBy, orderBy, page, perPage }) => {
      const clauses: string[] = [];
      if (filter) clauses.push(`(${filter})`);
      else if (!includeDone) clauses.push("done = false");
      if (assignedToMe) {
        const me = await vikunja.get<{ username: string }>("/user");
        clauses.push(`assignees in '${me.username}'`);
      }
      const effectiveFilter = clauses.length > 0 ? clauses.join(" && ") : undefined;
      // Vikunja >= 1.0 serves cross-project tasks at /tasks (the old /tasks/all returns 400).
      const path = projectId != null ? `/projects/${projectId}/tasks` : "/tasks";
      const data = await vikunja.get<Task[]>(path, {
        s: search,
        filter: effectiveFilter,
        sort_by: sortBy,
        order_by: orderBy,
        page,
        per_page: perPage,
      });
      return ok(data.map(summarizeTask));
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Get a single task with full details: description, dates, priority, labels and assignees.",
      inputSchema: { id: z.number().int().describe("Task id") },
    },
    guard(async ({ id }) => {
      const data = await vikunja.get<Task>(`/tasks/${id}`);
      return ok(fullTask(data));
    }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task in a project. Use list_projects to find the projectId and list_labels for label ids." +
        (defaultProjectId != null ? ` If projectId is omitted, project ${defaultProjectId} is used.` : ""),
      inputSchema: {
        projectId:
          defaultProjectId != null
            ? z.number().int().default(defaultProjectId).describe("Project id")
            : z.number().int().describe("Project id"),
        title: z.string().min(1).describe("Task title"),
        description: z.string().optional().describe("Task description (markdown/HTML accepted by Vikunja)"),
        dueDate: dateField.optional(),
        startDate: dateField.optional(),
        endDate: dateField.optional(),
        priority: priorityField.optional(),
        labelIds: z.array(z.number().int()).optional().describe("Label ids to attach"),
      },
    },
    guard(async ({ projectId, title, description, dueDate, startDate, endDate, priority, labelIds }) => {
      const body = stripUndefined({
        title,
        description,
        due_date: dueDate,
        start_date: startDate,
        end_date: endDate,
        priority,
      });
      let task = await vikunja.put<Task>(`/projects/${projectId}/tasks`, body);
      if (labelIds && labelIds.length > 0) {
        await setLabels(vikunja, task.id, labelIds);
        task = await vikunja.get<Task>(`/tasks/${task.id}`);
      }
      return ok(fullTask(task));
    }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Update fields of an existing task. Only the fields you pass are changed. To clear a date pass null. " +
        "labelIds, when given, REPLACES the task's labels. Use complete_task to just mark a task done.",
      inputSchema: {
        id: z.number().int().describe("Task id"),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        done: z.boolean().optional(),
        dueDate: dateField.nullable().optional(),
        startDate: dateField.nullable().optional(),
        endDate: dateField.nullable().optional(),
        priority: priorityField.optional(),
        percentDone: z.number().min(0).max(1).optional().describe("Progress as a fraction 0–1"),
        projectId: z.number().int().optional().describe("Move the task to another project"),
        labelIds: z.array(z.number().int()).optional().describe("Replace labels with these ids"),
      },
    },
    guard(async ({ id, title, description, done, dueDate, startDate, endDate, priority, percentDone, projectId, labelIds }) => {
      // Vikunja's POST /tasks/{id} replaces unspecified fields with zero values,
      // so merge the patch onto the current task before sending.
      const current = await vikunja.get<Task>(`/tasks/${id}`);
      const patch = stripUndefined({
        title,
        description,
        done,
        due_date: dueDate === null ? "0001-01-01T00:00:00Z" : dueDate,
        start_date: startDate === null ? "0001-01-01T00:00:00Z" : startDate,
        end_date: endDate === null ? "0001-01-01T00:00:00Z" : endDate,
        priority,
        percent_done: percentDone,
        project_id: projectId,
      });
      if (Object.keys(patch).length === 0 && labelIds === undefined) {
        throw new Error("Nothing to update.");
      }
      let task = current;
      if (Object.keys(patch).length > 0) {
        task = await vikunja.post<Task>(`/tasks/${id}`, { ...current, ...patch });
      }
      if (labelIds !== undefined) {
        await setLabels(vikunja, id, labelIds);
        task = await vikunja.get<Task>(`/tasks/${id}`);
      }
      return ok(fullTask(task));
    }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task as done (or reopen it with done=false).",
      inputSchema: {
        id: z.number().int().describe("Task id"),
        done: z.boolean().default(true).describe("false to reopen a completed task"),
      },
    },
    guard(async ({ id, done }) => {
      const current = await vikunja.get<Task>(`/tasks/${id}`);
      const task = await vikunja.post<Task>(`/tasks/${id}`, { ...current, done });
      return ok(summarizeTask(task));
    }),
  );

  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description: "List labels available to the user, with ids for use in create_task / update_task.",
      inputSchema: {
        search: z.string().optional().describe("Filter labels by title"),
        page: z.number().int().min(1).default(1),
        perPage: z.number().int().min(1).max(100).default(100),
      },
    },
    guard(async ({ search, page, perPage }) => {
      const data = await vikunja.get<Label[]>("/labels", { s: search, page, per_page: perPage });
      return ok(
        (data ?? []).map((l) => ({
          id: l.id,
          title: l.title,
          color: l.hex_color || null,
          description: l.description || null,
        })),
      );
    }),
  );

  server.registerTool(
    "create_label",
    {
      title: "Create label",
      description: "Create a new label.",
      inputSchema: {
        title: z.string().min(1),
        hexColor: z
          .string()
          .regex(/^[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Colour as 6 hex digits without '#', e.g. e8e8e8"),
        description: z.string().optional(),
      },
    },
    guard(async ({ title, hexColor, description }) => {
      const data = await vikunja.put<Label>("/labels", stripUndefined({ title, hex_color: hexColor, description }));
      return ok({ id: data.id, title: data.title, color: data.hex_color || null });
    }),
  );

  if (allowDelete) {
    server.registerTool(
      "delete_task",
      {
        title: "Delete task",
        description: "Permanently delete a task. Irreversible — only use when the user explicitly asks.",
        inputSchema: { id: z.number().int().describe("Task id") },
      },
      guard(async ({ id }) => {
        await vikunja.del(`/tasks/${id}`);
        return ok({ deleted: id });
      }),
    );
  }
}
