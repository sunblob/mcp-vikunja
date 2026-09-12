import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { VikunjaClient } from "../client.js";
import { ok, guard, escapeHtml, summarizeUser, type User } from "./_shared.js";
import type { Task } from "./tasks.js";

export interface Attachment {
  id: number;
  task_id?: number;
  created?: string;
  created_by?: User | null;
  file?: { id?: number; name?: string; mime?: string; size?: number } | null;
}

export function summarizeAttachment(a: Attachment) {
  return {
    id: a.id,
    name: a.file?.name ?? null,
    mime: a.file?.mime || null,
    size: a.file?.size ?? null,
    created: a.created,
    createdBy: summarizeUser(a.created_by),
  };
}

export const filePathsField = z.array(z.string().min(1)).min(1).describe("Absolute paths of local files to upload");

export interface UploadResult {
  uploaded: Attachment[];
  errors: string[];
}

/** Upload local files as task attachments. Throws only when every file failed. */
export async function uploadAttachments(vikunja: VikunjaClient, taskId: number, filePaths: string[]): Promise<UploadResult> {
  const form = new FormData();
  for (const p of filePaths) {
    const abs = path.resolve(p);
    form.append("files", await fs.openAsBlob(abs), path.basename(abs));
  }
  const res = await vikunja.upload<{ success?: Attachment[] | null; errors?: { message?: string }[] | null }>(
    `/tasks/${taskId}/attachments`,
    form,
  );
  const uploaded = res?.success ?? [];
  const errors = (res?.errors ?? []).map((e) => e.message ?? JSON.stringify(e));
  if (errors.length > 0 && uploaded.length === 0) throw new Error(`Upload failed: ${errors.join("; ")}`);
  return { uploaded, errors };
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

/**
 * Show attachments inside a description or comment the way the web editor does:
 * images as `<img data-src>` (the UI fetches them with the viewer's token), other files by name.
 * Vikunja has no comment-level attachments, so these are always task attachments.
 */
export function attachmentHtml(vikunja: VikunjaClient, taskId: number, attachments: Attachment[]): string {
  if (attachments.length === 0) return "";
  const parts = attachments.map((a) => {
    const name = a.file?.name || `attachment-${a.id}`;
    if (a.file?.mime?.startsWith("image/") || IMAGE_EXTENSIONS.test(name)) {
      return `<img data-src="${vikunja.baseUrl}/api/v1/tasks/${taskId}/attachments/${a.id}" src="#" id="tiptap-image-${taskId}-${a.id}">`;
    }
    return `<p>📎 ${escapeHtml(name)} (attachment #${a.id})</p>`;
  });
  // The editor always leaves an empty paragraph after embedded content.
  return parts.join("") + "<p></p>";
}

/** Add what was uploaded (and any per-file failures) to a tool result. */
export function withUploadInfo<T extends object>(result: T, files: UploadResult | null) {
  if (!files) return result;
  return {
    ...result,
    uploaded: files.uploaded.map(summarizeAttachment),
    ...(files.errors.length > 0 ? { uploadErrors: files.errors } : {}),
  };
}

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_BYTES = 1_000_000;
const MAX_INLINE_TEXT_BYTES = 200_000;

function isTextual(mime: string): boolean {
  return /^text\/|json|xml|yaml|csv|markdown|javascript/.test(mime);
}

function safeFileName(name: string | undefined, fallback: string): string {
  const base = path.basename((name || "").replace(/[\\/]/g, "_"));
  return base && base !== "." && base !== ".." ? base : fallback;
}

export function registerAttachmentTools(
  server: McpServer,
  vikunja: VikunjaClient,
  { allowDelete = false }: { allowDelete?: boolean } = {},
): void {
  server.registerTool(
    "list_task_attachments",
    {
      title: "List task attachments",
      description: "List files attached to a task (id, name, mime type, size, uploader).",
      inputSchema: {
        taskId: z.number().int().describe("Task id"),
        page: z.number().int().min(1).default(1),
        perPage: z.number().int().min(1).max(100).default(50),
      },
    },
    guard(async ({ taskId, page, perPage }) => {
      const data = await vikunja.get<Attachment[] | null>(`/tasks/${taskId}/attachments`, { page, per_page: perPage });
      return ok((data ?? []).map(summarizeAttachment));
    }),
  );

  server.registerTool(
    "upload_task_attachment",
    {
      title: "Upload task attachment",
      description:
        "Attach one or more local files to a task. To also show them in a comment or the description, use filePaths on " +
        "add_task_comment / update_task_comment or descriptionFilePaths on create_task / update_task instead.",
      inputSchema: {
        taskId: z.number().int().describe("Task id"),
        filePaths: filePathsField,
      },
    },
    guard(async ({ taskId, filePaths }) => {
      const { uploaded, errors } = await uploadAttachments(vikunja, taskId, filePaths);
      return ok({ uploaded: uploaded.map(summarizeAttachment), errors });
    }),
  );

  server.registerTool(
    "download_task_attachment",
    {
      title: "Download task attachment",
      description:
        "Save a task attachment to a local file. Small images and text files are also returned inline so you can read them.",
      inputSchema: {
        taskId: z.number().int().describe("Task id"),
        attachmentId: z.number().int().describe("Attachment id (from get_task or list_task_attachments)"),
        outputPath: z
          .string()
          .optional()
          .describe("Where to save the file; defaults to <tmp>/mcp-vikunja/task-<taskId>/<file name>"),
      },
    },
    guard(async ({ taskId, attachmentId, outputPath }) => {
      const task = await vikunja.get<Task>(`/tasks/${taskId}`);
      const attachment = (task.attachments ?? []).find((a) => a.id === attachmentId);
      if (!attachment) throw new Error(`Attachment ${attachmentId} not found on task ${taskId}.`);

      const { data, contentType } = await vikunja.download(`/tasks/${taskId}/attachments/${attachmentId}`);
      const name = safeFileName(attachment.file?.name, `attachment-${attachmentId}`);
      const target = path.resolve(outputPath ?? path.join(os.tmpdir(), "mcp-vikunja", `task-${taskId}`, name));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);

      const mime = (attachment.file?.mime || contentType || "application/octet-stream").split(";")[0]!.trim();
      const content: CallToolResult["content"] = [
        { type: "text", text: JSON.stringify({ savedTo: target, name, mime, size: data.length }, null, 2) },
      ];
      if (INLINE_IMAGE_TYPES.has(mime) && data.length <= MAX_INLINE_IMAGE_BYTES) {
        content.push({ type: "image", data: data.toString("base64"), mimeType: mime });
      } else if (isTextual(mime) && data.length <= MAX_INLINE_TEXT_BYTES) {
        content.push({ type: "text", text: data.toString("utf8") });
      }
      return { content };
    }),
  );

  if (allowDelete) {
    server.registerTool(
      "delete_task_attachment",
      {
        title: "Delete task attachment",
        description: "Permanently delete an attachment. Irreversible — only use when the user explicitly asks.",
        inputSchema: {
          taskId: z.number().int().describe("Task id"),
          attachmentId: z.number().int().describe("Attachment id"),
        },
      },
      guard(async ({ taskId, attachmentId }) => {
        await vikunja.del(`/tasks/${taskId}/attachments/${attachmentId}`);
        return ok({ deleted: attachmentId });
      }),
    );
  }
}
