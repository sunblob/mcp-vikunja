import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
