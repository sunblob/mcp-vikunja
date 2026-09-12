# @fswap/mcp-vikunja

An [MCP](https://modelcontextprotocol.io) server for [Vikunja](https://vikunja.io) that lets Claude Desktop, Claude Code, Cursor and other MCP clients list, create, update and complete your tasks.

Runs locally over stdio. No install step — clients launch it with `npx`.

## Quick start

1. Create an API token in Vikunja under **Settings → API Tokens** (scope it to projects, tasks and labels).
2. Run the interactive setup once:

   ```bash
   npx -y @fswap/mcp-vikunja setup
   ```

   It asks for your Vikunja URL and token, verifies them against `/api/v1/user`, lets you pick a default project, and stores the answers in your OS config directory (mode `0600`).

3. Add the server to your client. Every value asked in `setup` can be skipped with Enter; anything you skip goes into the `env` block shown below instead. `setup --print` shows these snippets again at any time.

   **Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json` or `<project>/.cursor/mcp.json`):

   ```json
   {
     "mcpServers": {
       "vikunja": {
         "command": "npx",
         "args": ["-y", "@fswap/mcp-vikunja"]
       }
     }
   }
   ```

   **Codex** (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.vikunja]
   command = "npx"
   args = ["-y", "@fswap/mcp-vikunja"]
   ```

   **Claude Code**:

   ```bash
   claude mcp add vikunja -- npx -y @fswap/mcp-vikunja
   ```

### Without `setup` (environment variables)

Environment variables take precedence over the config file, so you can skip `setup` entirely (or skip individual values in it and set them here):

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "npx",
      "args": ["-y", "@fswap/mcp-vikunja"],
      "env": {
        "VIKUNJA_URL": "https://try.vikunja.io",
        "VIKUNJA_API_TOKEN": "tk_..."
      }
    }
  }
}
```

Codex equivalent:

```toml
[mcp_servers.vikunja]
command = "npx"
args = ["-y", "@fswap/mcp-vikunja"]
[mcp_servers.vikunja.env]
VIKUNJA_URL = "https://try.vikunja.io"
VIKUNJA_API_TOKEN = "tk_..."
```

| Variable | Purpose |
|---|---|
| `VIKUNJA_URL` | Vikunja base URL (with or without `/api/v1`) |
| `VIKUNJA_API_TOKEN` | API token or login JWT |
| `VIKUNJA_ALLOW_DELETE` | `true` to expose `delete_task` |
| `VIKUNJA_DEFAULT_PROJECT_ID` | Project used by `create_task` when `projectId` is omitted |

## Tools

| Tool | Method + endpoint | Notes |
|---|---|---|
| `list_projects` | `GET /projects` | id, title, description, parent |
| `get_project` | `GET /projects/{id}` | |
| `create_project` | `PUT /projects` | optional parent project |
| `list_tasks` | `GET /tasks` or `GET /projects/{id}/tasks` | open tasks by default; `assignedToMe`, `filter`, `sortBy`, pagination |
| `get_task` | `GET /tasks/{id}` | full task incl. description, labels, assignees |
| `create_task` | `PUT /projects/{id}/tasks` | title, description, dates, priority, labels |
| `update_task` | `POST /tasks/{id}` | merges your changes onto the current task; `labelIds` replaces labels |
| `complete_task` | `POST /tasks/{id}` with `done: true` | `done=false` reopens |
| `list_labels` | `GET /labels` | label ids for create/update |
| `create_label` | `PUT /labels` | |
| `delete_task` | `DELETE /tasks/{id}` | only when delete is allowed (setup answer or `VIKUNJA_ALLOW_DELETE=true`) |

Every task and project includes a `url` to its page in the Vikunja web UI (taken from `/info` `frontend_url`). Vikunja's zero date (`0001-01-01T00:00:00Z`) is normalised to `null` in every response. API errors are returned to the model as `isError` results rather than crashing the server.

## Development

TypeScript source in `src/`, bundled to `dist/` with [tsdown](https://tsdown.dev). Only `dist/` is published.

```bash
npm install
npm run build        # tsdown → dist/index.js
npm run lint         # eslint (typescript-eslint)
npm run typecheck    # tsc --noEmit
npm test             # builds, then spawns the server and checks the tool list
npm run check        # all of the above (also runs on prepublishOnly)
VIKUNJA_URL=... VIKUNJA_API_TOKEN=... npm run inspect   # MCP Inspector UI against dist/
```

Never write to stdout from server code — it is the protocol channel. Use `console.error`.

## Reset

```bash
npx -y @fswap/mcp-vikunja setup --reset
```

## License

MIT
