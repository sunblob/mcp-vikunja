import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { VikunjaClient } from "../client.js";

export function ok(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Wrap a tool handler so API errors become isError results instead of crashes. */
export function guard<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface User {
  id: number;
  username: string;
  name?: string;
}

export function summarizeUser(u: User | null | undefined) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name || null };
}

let frontendBase: string | null = null;

/** Resolve the web UI base URL once (Vikunja's API host may differ from its frontend host). */
export async function frontendUrl(vikunja: VikunjaClient): Promise<string> {
  if (frontendBase) return frontendBase;
  try {
    const info = await vikunja.get<{ frontend_url?: string }>("/info");
    frontendBase = (info.frontend_url || vikunja.baseUrl).replace(/\/+$/, "");
  } catch {
    frontendBase = vikunja.baseUrl;
  }
  return frontendBase;
}

/**
 * Vikunja stores descriptions and comments as HTML. Pass HTML through untouched;
 * wrap plain text in paragraphs so line breaks survive.
 */
export function toHtml(text: string): string {
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return text;
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escape(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Reaction map `{ "👍": [users] }` → `{ "👍": ["alice"] }`, or null when empty. */
export function summarizeReactions(map: Record<string, User[]> | null | undefined) {
  if (!map || Object.keys(map).length === 0) return null;
  return Object.fromEntries(Object.entries(map).map(([value, users]) => [value, users.map((u) => u.username)]));
}
