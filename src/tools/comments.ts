import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { ok, guard, toHtml, summarizeUser, summarizeReactions, type User } from "./_shared.js";
import { uploadAttachments, attachmentHtml, withUploadInfo, filePathsField } from "./attachments.js";

export interface Comment {
  id: number;
  comment: string;
  author?: User | null;
  reactions?: Record<string, User[]> | null;
  created?: string;
  updated?: string;
}

export function summarizeComment(c: Comment) {
  return {
    id: c.id,
    author: summarizeUser(c.author),
    comment: c.comment,
    reactions: summarizeReactions(c.reactions),
    created: c.created,
    // Fresh comments come back with created/updated a few nanoseconds apart.
    edited: c.updated && c.created && Date.parse(c.updated) - Date.parse(c.created) > 1000 ? c.updated : null,
  };
}

const commentText = z
  .string()
  .min(1)
  .describe("Comment body. HTML is sent as-is; plain text is wrapped in <p> (blank line = new paragraph)");

const commentFiles = filePathsField.describe(
  "Absolute paths of local files to upload as task attachments and show in the comment: images inline, other files by name",
);

export function registerCommentTools(
  server: McpServer,
  vikunja: VikunjaClient,
  { allowDelete = false }: { allowDelete?: boolean } = {},
): void {
  server.registerTool(
    "list_task_comments",
    {
      title: "List task comments",
      description: "List all comments on a task with author, HTML body, reactions and timestamps.",
      inputSchema: {
        taskId: z.number().int().describe("Task id"),
        order: z.enum(["asc", "desc"]).default("asc").describe("asc = oldest first"),
      },
    },
    guard(async ({ taskId, order }) => {
      const data = await vikunja.get<Comment[] | null>(`/tasks/${taskId}/comments`, { order_by: order });
      return ok((data ?? []).map(summarizeComment));
    }),
  );

  server.registerTool(
    "add_task_comment",
    {
      title: "Add task comment",
      description:
        "Post a comment on a task as the current user, optionally with files shown in it. " +
        "Visible to everyone with access to the task.",
      inputSchema: {
        taskId: z.number().int().describe("Task id"),
        comment: commentText.optional(),
        filePaths: commentFiles.optional(),
      },
    },
    guard(async ({ taskId, comment, filePaths }) => {
      if (!comment && !filePaths) throw new Error("Pass comment, filePaths, or both.");
      const files = filePaths ? await uploadAttachments(vikunja, taskId, filePaths) : null;
      const body = (comment ? toHtml(comment) : "") + (files ? attachmentHtml(vikunja, taskId, files.uploaded) : "");
      const data = await vikunja.put<Comment>(`/tasks/${taskId}/comments`, { comment: body });
      return ok(withUploadInfo(summarizeComment(data), files));
    }),
  );

  server.registerTool(
    "update_task_comment",
    {
      title: "Edit task comment",
      description:
        "Replace the text of an existing comment and/or add files to it. filePaths without comment keeps the current text.",
      inputSchema: {
        taskId: z.number().int().describe("Task id"),
        commentId: z.number().int().describe("Comment id"),
        comment: commentText.optional(),
        filePaths: commentFiles.optional(),
      },
    },
    guard(async ({ taskId, commentId, comment, filePaths }) => {
      if (!comment && !filePaths) throw new Error("Pass comment, filePaths, or both.");
      const text = comment
        ? toHtml(comment)
        : ((await vikunja.get<Comment>(`/tasks/${taskId}/comments/${commentId}`)).comment ?? "");
      const files = filePaths ? await uploadAttachments(vikunja, taskId, filePaths) : null;
      const body = text + (files ? attachmentHtml(vikunja, taskId, files.uploaded) : "");
      const data = await vikunja.post<Comment>(`/tasks/${taskId}/comments/${commentId}`, { comment: body });
      return ok(withUploadInfo(summarizeComment(data), files));
    }),
  );

  server.registerTool(
    "set_reaction",
    {
      title: "Add / remove reaction",
      description: "Add an emoji reaction (or remove yours with remove=true) on a task or a task comment.",
      inputSchema: {
        entity: z.enum(["task", "comment"]).default("task"),
        id: z.number().int().describe("Task id, or comment id when entity=comment"),
        reaction: z.string().min(1).max(20).describe("Emoji or short text, e.g. 👍"),
        remove: z.boolean().default(false),
      },
    },
    guard(async ({ entity, id, reaction, remove }) => {
      const kind = entity === "task" ? "tasks" : "comments";
      if (remove) await vikunja.post(`/${kind}/${id}/reactions/delete`, { value: reaction });
      else await vikunja.put(`/${kind}/${id}/reactions`, { value: reaction });
      return ok({ entity, id, reaction, active: !remove });
    }),
  );

  if (allowDelete) {
    server.registerTool(
      "delete_task_comment",
      {
        title: "Delete task comment",
        description: "Permanently delete a comment. Irreversible — only use when the user explicitly asks.",
        inputSchema: {
          taskId: z.number().int().describe("Task id"),
          commentId: z.number().int().describe("Comment id"),
        },
      },
      guard(async ({ taskId, commentId }) => {
        await vikunja.del(`/tasks/${taskId}/comments/${commentId}`);
        return ok({ deleted: commentId });
      }),
    );
  }
}
