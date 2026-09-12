import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeDate, ZERO_DATE, type VikunjaClient } from "../client.js";
import { ok, guard, stripUndefined, frontendUrl, summarizeUser, type User } from "./_shared.js";
import {
  summarizeAttachment,
  uploadAttachments,
  attachmentHtml,
  withUploadInfo,
  filePathsField,
  type Attachment,
  type UploadResult,
} from "./attachments.js";
import { summarizeComment, type Comment } from "./comments.js";

interface Label {
  id: number;
  title: string;
  hex_color?: string;
  description?: string;
}

interface Reminder {
  reminder?: string;
  relative_to?: string;
  relative_period?: number;
}

interface TaskBucket {
  id: number;
  title: string;
  project_view_id: number;
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
  hex_color?: string;
  is_favorite?: boolean;
  project_id: number;
  labels?: Label[] | null;
  assignees?: User[] | null;
  reminders?: Reminder[] | null;
  related_tasks?: Record<string, Task[] | null> | null;
  attachments?: Attachment[] | null;
  cover_image_attachment_id?: number;
  subscription?: { entity: string | number; entity_id: number } | null;
  buckets?: TaskBucket[] | null;
  created_by?: User | null;
  created?: string;
  updated?: string;
  identifier?: string;
  repeat_after?: number;
  repeat_mode?: number;
  bucket_id?: number;
}

/** Index = Vikunja's numeric repeat_mode. */
const REPEAT_MODES = ["default", "monthly", "fromCurrentDate"] as const;

function summarizeTask(t: Task, base: string) {
  return {
    id: t.id,
    title: t.title,
    url: `${base}/tasks/${t.id}`,
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

function fullTask(t: Task, base: string) {
  return {
    ...summarizeTask(t, base),
    description: t.description || "",
    doneAt: normalizeDate(t.done_at),
    startDate: normalizeDate(t.start_date),
    endDate: normalizeDate(t.end_date),
    percentDone: t.percent_done ?? 0,
    color: t.hex_color || null,
    favorite: Boolean(t.is_favorite),
    repeat:
      t.repeat_after || t.repeat_mode
        ? { afterSeconds: t.repeat_after || 0, mode: REPEAT_MODES[t.repeat_mode ?? 0] ?? "default" }
        : null,
    reminders: (t.reminders ?? []).map((r) =>
      r.relative_to
        ? { relativeTo: r.relative_to, relativePeriodSeconds: r.relative_period ?? 0, reminder: normalizeDate(r.reminder) }
        : { reminder: normalizeDate(r.reminder) },
    ),
    labels: (t.labels ?? []).map((l) => ({ id: l.id, title: l.title, color: l.hex_color || null })),
    assignees: (t.assignees ?? []).map((u) => summarizeUser(u)),
    subscription: t.subscription ? { entity: t.subscription.entity, entityId: t.subscription.entity_id } : null,
    relatedTasks: Object.fromEntries(
      Object.entries(t.related_tasks ?? {}).map(([kind, tasks]) => [
        kind,
        (tasks ?? []).map((r) => ({ id: r.id, title: r.title, done: r.done, projectId: r.project_id, url: `${base}/tasks/${r.id}` })),
      ]),
    ),
    attachments: (t.attachments ?? []).map(summarizeAttachment),
    coverImageAttachmentId: t.cover_image_attachment_id || null,
    kanbanBuckets: t.buckets ? t.buckets.map((b) => ({ id: b.id, title: b.title, viewId: b.project_view_id })) : undefined,
    createdBy: summarizeUser(t.created_by),
    created: t.created,
  };
}

/** Fetch one task including its kanban buckets; falls back for Vikunja versions without `expand`. */
async function fetchTask(vikunja: VikunjaClient, id: number): Promise<Task> {
  try {
    return await vikunja.get<Task>(`/tasks/${id}`, { expand: "buckets" });
  } catch {
    return vikunja.get<Task>(`/tasks/${id}`);
  }
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

const reminderField = z
  .object({
    reminder: dateField.optional().describe("Absolute reminder time"),
    relativeTo: z.enum(["due_date", "start_date", "end_date"]).optional().describe("Date the reminder is relative to"),
    relativePeriodSeconds: z
      .number()
      .int()
      .optional()
      .describe("Offset from relativeTo in seconds; negative = before (e.g. -3600 = one hour before)"),
  })
  .refine((r) => r.reminder !== undefined || r.relativeTo !== undefined, "Give either reminder or relativeTo");

type ReminderInput = z.infer<typeof reminderField>;

/** Fields shared by create_task and update_task beyond the basic ones. */
const extraFields = {
  percentDone: z.number().min(0).max(1).optional().describe("Progress as a fraction 0–1 (the UI uses 10% steps)"),
  hexColor: z
    .string()
    .regex(/^#?([0-9a-fA-F]{6})?$/)
    .optional()
    .describe("Task colour as 6 hex digits, e.g. 1973ff; empty string removes the colour"),
  isFavorite: z.boolean().optional().describe("Add to (true) or remove from (false) the current user's favorites"),
  repeatAfterSeconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Repeat interval in seconds (3600 hourly, 86400 daily, 604800 weekly); 0 stops repeating"),
  repeatMode: z
    .enum(REPEAT_MODES)
    .optional()
    .describe(
      "default = shift dates by repeatAfterSeconds when marked done; monthly = same day next month " +
        "(ignores repeatAfterSeconds); fromCurrentDate = shift from the moment it is marked done",
    ),
  reminders: z.array(reminderField).optional().describe("REPLACES all reminders; [] removes them"),
  labelIds: z.array(z.number().int()).optional().describe("Label ids (list_labels); REPLACES the task's labels"),
  assigneeIds: z
    .array(z.number().int())
    .optional()
    .describe("User ids (find_users / get_current_user); REPLACES the assignees, [] unassigns everyone"),
  descriptionFilePaths: filePathsField
    .optional()
    .describe(
      "Absolute paths of local files to upload as task attachments and show at the end of the description: " +
        "images inline, other files by name",
    ),
};

interface ExtraArgs {
  percentDone?: number;
  hexColor?: string;
  isFavorite?: boolean;
  repeatAfterSeconds?: number;
  repeatMode?: (typeof REPEAT_MODES)[number];
  reminders?: ReminderInput[];
}

function toApiReminder(r: ReminderInput): Reminder {
  if (r.relativeTo) return { relative_to: r.relativeTo, relative_period: r.relativePeriodSeconds ?? 0 };
  return { reminder: r.reminder };
}

function extraBody(a: ExtraArgs) {
  return stripUndefined({
    percent_done: a.percentDone,
    hex_color: a.hexColor?.replace(/^#/, ""),
    is_favorite: a.isFavorite,
    repeat_after: a.repeatAfterSeconds,
    repeat_mode: a.repeatMode === undefined ? undefined : REPEAT_MODES.indexOf(a.repeatMode),
    reminders: a.reminders?.map(toApiReminder),
  });
}

/** Replace the task's labels with exactly `labelIds` (Vikunja has no single-call "set labels"). */
async function setLabels(vikunja: VikunjaClient, taskId: number, labelIds: number[]): Promise<void> {
  await vikunja.post(`/tasks/${taskId}/labels/bulk`, { labels: labelIds.map((id) => ({ id })) });
}

/** Replace the task's assignees; users missing from the list are unassigned. */
async function setAssignees(vikunja: VikunjaClient, taskId: number, userIds: number[]): Promise<void> {
  await vikunja.post(`/tasks/${taskId}/assignees/bulk`, { assignees: userIds.map((id) => ({ id })) });
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
        "names, assignee usernames and a web url (no descriptions — use get_task). By default only open tasks are returned. " +
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
      const base = await frontendUrl(vikunja);
      return ok(data.map((t) => summarizeTask(t, base)));
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Get a single task with full details: description, dates, priority, progress, colour, favorite, repeat, " +
        "reminders, labels, assignees, subscription, related tasks, attachments, kanban buckets and (by default) comments.",
      inputSchema: {
        id: z.number().int().describe("Task id"),
        includeComments: z.boolean().default(true).describe("Also return the task's comments (oldest first)"),
      },
    },
    guard(async ({ id, includeComments }) => {
      const [task, comments] = await Promise.all([
        fetchTask(vikunja, id),
        includeComments ? vikunja.get<Comment[] | null>(`/tasks/${id}/comments`) : Promise.resolve(undefined),
      ]);
      const result = fullTask(task, await frontendUrl(vikunja));
      return ok(comments === undefined ? result : { ...result, comments: (comments ?? []).map(summarizeComment) });
    }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task in a project. Use list_projects for the projectId, list_labels for label ids and find_users " +
        "for assignee ids. Descriptions are HTML." +
        (defaultProjectId != null ? ` If projectId is omitted, project ${defaultProjectId} is used.` : ""),
      inputSchema: {
        projectId:
          defaultProjectId != null
            ? z.number().int().default(defaultProjectId).describe("Project id")
            : z.number().int().describe("Project id"),
        title: z.string().min(1).describe("Task title"),
        description: z.string().optional().describe("Task description (HTML)"),
        dueDate: dateField.optional(),
        startDate: dateField.optional(),
        endDate: dateField.optional(),
        priority: priorityField.optional(),
        ...extraFields,
      },
    },
    guard(async ({ projectId, title, description, dueDate, startDate, endDate, priority, labelIds, assigneeIds, descriptionFilePaths, ...extra }) => {
      const body = {
        ...stripUndefined({ title, description, due_date: dueDate, start_date: startDate, end_date: endDate, priority }),
        ...extraBody(extra),
      };
      let task = await vikunja.put<Task>(`/projects/${projectId}/tasks`, body);
      if (labelIds && labelIds.length > 0) await setLabels(vikunja, task.id, labelIds);
      if (assigneeIds && assigneeIds.length > 0) await setAssignees(vikunja, task.id, assigneeIds);
      let files: UploadResult | null = null;
      if (descriptionFilePaths) {
        // Attachments need the task id, so they are embedded with a second update.
        files = await uploadAttachments(vikunja, task.id, descriptionFilePaths);
        const current = await vikunja.get<Task>(`/tasks/${task.id}`);
        await vikunja.post<Task>(`/tasks/${task.id}`, {
          ...current,
          description: (current.description || "") + attachmentHtml(vikunja, task.id, files.uploaded),
        });
      }
      if (labelIds?.length || assigneeIds?.length || files) task = await fetchTask(vikunja, task.id);
      return ok(withUploadInfo(fullTask(task, await frontendUrl(vikunja)), files));
    }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Update fields of an existing task. Only the fields you pass are changed. To clear a date pass null. " +
        "labelIds, assigneeIds and reminders REPLACE the current values. projectId moves the task to another project. " +
        "Use complete_task to just mark a task done.",
      inputSchema: {
        id: z.number().int().describe("Task id"),
        title: z.string().min(1).optional(),
        description: z.string().optional().describe("Task description (HTML)"),
        done: z.boolean().optional(),
        dueDate: dateField.nullable().optional(),
        startDate: dateField.nullable().optional(),
        endDate: dateField.nullable().optional(),
        priority: priorityField.optional(),
        projectId: z.number().int().optional().describe("Move the task to another project"),
        ...extraFields,
      },
    },
    guard(async ({ id, title, description, done, dueDate, startDate, endDate, priority, projectId, labelIds, assigneeIds, descriptionFilePaths, ...extra }) => {
      const patch = {
        ...stripUndefined({
          title,
          description,
          done,
          due_date: dueDate === null ? ZERO_DATE : dueDate,
          start_date: startDate === null ? ZERO_DATE : startDate,
          end_date: endDate === null ? ZERO_DATE : endDate,
          priority,
          project_id: projectId,
        }),
        ...extraBody(extra),
      };
      if (Object.keys(patch).length === 0 && !descriptionFilePaths && labelIds === undefined && assigneeIds === undefined) {
        throw new Error("Nothing to update.");
      }
      let files: UploadResult | null = null;
      if (Object.keys(patch).length > 0 || descriptionFilePaths) {
        // Vikunja's POST /tasks/{id} replaces unspecified fields with zero values,
        // so merge the patch onto the current task before sending.
        const current = await vikunja.get<Task>(`/tasks/${id}`);
        if (descriptionFilePaths) {
          files = await uploadAttachments(vikunja, id, descriptionFilePaths);
          patch.description = (description ?? current.description ?? "") + attachmentHtml(vikunja, id, files.uploaded);
        }
        await vikunja.post<Task>(`/tasks/${id}`, { ...current, ...patch });
      }
      if (labelIds !== undefined) await setLabels(vikunja, id, labelIds);
      if (assigneeIds !== undefined) await setAssignees(vikunja, id, assigneeIds);
      return ok(withUploadInfo(fullTask(await fetchTask(vikunja, id), await frontendUrl(vikunja)), files));
    }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task as done (or undone / reopen it with done=false).",
      inputSchema: {
        id: z.number().int().describe("Task id"),
        done: z.boolean().default(true).describe("false to reopen a completed task"),
      },
    },
    guard(async ({ id, done }) => {
      const current = await vikunja.get<Task>(`/tasks/${id}`);
      const task = await vikunja.post<Task>(`/tasks/${id}`, { ...current, done });
      return ok(summarizeTask(task, await frontendUrl(vikunja)));
    }),
  );

  server.registerTool(
    "duplicate_task",
    {
      title: "Duplicate task",
      description:
        "Copy a task with labels, assignees, attachments and reminders into the same project. " +
        'The copy gets a "copiedfrom" relation to the original.',
      inputSchema: { id: z.number().int().describe("Task id to duplicate") },
    },
    guard(async ({ id }) => {
      const res = await vikunja.put<{ duplicated_task?: Task }>(`/tasks/${id}/duplicate`);
      if (!res?.duplicated_task) throw new Error("Vikunja did not return the duplicated task.");
      return ok(fullTask(res.duplicated_task, await frontendUrl(vikunja)));
    }),
  );

  server.registerTool(
    "set_subscription",
    {
      title: "Subscribe / unsubscribe",
      description:
        "Subscribe the current user to notifications for a task or project, or unsubscribe (subscribed=false). " +
        "A task subscription may be inherited from its project; then unsubscribe from the project instead.",
      inputSchema: {
        entity: z.enum(["task", "project"]).default("task"),
        id: z.number().int().describe("Task or project id"),
        subscribed: z.boolean().default(true).describe("false to unsubscribe"),
      },
    },
    guard(async ({ entity, id, subscribed }) => {
      if (entity === "task") {
        const task = await vikunja.get<Task>(`/tasks/${id}`);
        const sub = task.subscription;
        if (Boolean(sub) === subscribed) {
          return ok({ entity, id, subscribed, changed: false, via: sub ? String(sub.entity) : null });
        }
        if (sub && String(sub.entity) !== "task") {
          throw new Error(
            `Task ${id} inherits its subscription from project ${task.project_id}; ` +
              `unsubscribe with entity="project", id=${task.project_id}.`,
          );
        }
      }
      if (subscribed) await vikunja.put(`/subscriptions/${entity}/${id}`);
      else await vikunja.del(`/subscriptions/${entity}/${id}`);
      return ok({ entity, id, subscribed, changed: true });
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
