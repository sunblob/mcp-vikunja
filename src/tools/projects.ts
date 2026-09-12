import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VikunjaClient } from "../client.js";
import { ok, guard } from "./_shared.js";

export interface Project {
  id: number;
  title: string;
  description?: string;
  identifier?: string;
  parent_project_id?: number;
  is_archived?: boolean;
  is_favorite?: boolean;
  created?: string;
  updated?: string;
}

export function summarizeProject(p: Project) {
  return {
    id: p.id,
    title: p.title,
    description: p.description || null,
    identifier: p.identifier || null,
    parentProjectId: p.parent_project_id || null,
    archived: Boolean(p.is_archived),
    favorite: Boolean(p.is_favorite),
  };
}

export function registerProjectTools(server: McpServer, vikunja: VikunjaClient): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List Vikunja projects the user can access. Returns id, title, description, identifier and parent project. " +
        "Use the id with list_tasks or create_task.",
      inputSchema: {
        search: z.string().optional().describe("Filter projects by title"),
        includeArchived: z.boolean().default(false).describe("Include archived projects"),
        page: z.number().int().min(1).default(1),
        perPage: z.number().int().min(1).max(100).default(50),
      },
    },
    guard(async ({ search, includeArchived, page, perPage }) => {
      const data = await vikunja.get<Project[]>("/projects", {
        s: search,
        is_archived: includeArchived ? true : undefined,
        page,
        per_page: perPage,
      });
      return ok(data.map(summarizeProject));
    }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Get one Vikunja project by id.",
      inputSchema: { id: z.number().int().describe("Project id") },
    },
    guard(async ({ id }) => {
      const data = await vikunja.get<Project>(`/projects/${id}`);
      return ok(summarizeProject(data));
    }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: "Create a new Vikunja project. Optionally nest it under a parent project.",
      inputSchema: {
        title: z.string().min(1).describe("Project title"),
        description: z.string().optional().describe("Project description"),
        parentProjectId: z.number().int().optional().describe("Parent project id for nesting"),
      },
    },
    guard(async ({ title, description, parentProjectId }) => {
      const body: Record<string, unknown> = { title };
      if (description !== undefined) body.description = description;
      if (parentProjectId !== undefined) body.parent_project_id = parentProjectId;
      const data = await vikunja.put<Project>("/projects", body);
      return ok(summarizeProject(data));
    }),
  );
}
