/**
 * Thin wrapper around the Vikunja REST API (`<baseUrl>/api/v1`).
 *
 * Vikunja quirks worth remembering:
 *  - PUT creates, POST updates (the opposite of most REST APIs).
 *  - "No date" is the zero time `0001-01-01T00:00:00Z`; normalise it to null (see `normalizeDate`).
 */

export type Method = "GET" | "PUT" | "POST" | "DELETE";

export type Query = Record<string, string | number | boolean | undefined>;

export interface VikunjaClient {
  baseUrl: string;
  request<T = unknown>(method: Method, path: string, body?: unknown, query?: Query): Promise<T>;
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  /** PUT a multipart form (file uploads) and parse the JSON response. */
  upload<T = unknown>(path: string, form: FormData): Promise<T>;
  /** GET a binary resource (attachment download). */
  download(path: string): Promise<{ data: Buffer; contentType: string | null }>;
}

export const ZERO_DATE = "0001-01-01T00:00:00Z";

export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value === ZERO_DATE || value.startsWith("0001-01-01")) return null;
  return value;
}

export function makeClient(baseUrl: string, token: string): VikunjaClient {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");

  async function send(method: Method, path: string, init: RequestInit, query?: Query): Promise<Response> {
    const url = new URL(`${base}/api/v1${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        method,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
      });
    } catch (err) {
      throw new Error(`${method} ${path} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try {
        const json = JSON.parse(text) as { message?: string; code?: number };
        detail = json.message ? `${json.message}${json.code ? ` (code ${json.code})` : ""}` : text;
      } catch {
        /* keep raw text */
      }
      throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
    }
    return res;
  }

  async function parseJson<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function request<T>(method: Method, path: string, body?: unknown, query?: Query): Promise<T> {
    const res = await send(
      method,
      path,
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      query,
    );
    return parseJson<T>(res);
  }

  return {
    baseUrl: base,
    request,
    get: (path, query) => request("GET", path, undefined, query),
    put: (path, body) => request("PUT", path, body),
    post: (path, body) => request("POST", path, body),
    del: (path) => request("DELETE", path),
    // fetch sets the multipart boundary itself, so no Content-Type here.
    upload: async (path, form) => parseJson(await send("PUT", path, { headers: { Accept: "application/json" }, body: form })),
    download: async (path) => {
      const res = await send("GET", path, {});
      return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
    },
  };
}

export interface VikunjaUser {
  id: number;
  username: string;
  name?: string;
  email?: string;
}

/** Cheap authenticated call used by `setup` to validate URL + token. */
export async function currentUser(baseUrl: string, token: string): Promise<VikunjaUser> {
  return makeClient(baseUrl, token).get<VikunjaUser>("/user");
}
