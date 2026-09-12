# @fswap/mcp-vikunja

An [MCP](https://modelcontextprotocol.io) server for [Vikunja](https://vikunja.io) that lets Claude Desktop, Claude Code, Cursor and other MCP clients manage your tasks: create, update, complete, assign, comment, attach files, relate, move on kanban boards and everything else in the task menu.

Runs locally over stdio. No install step — clients launch it with `npx`.

## Quick start

1. Create an API token in Vikunja under **Settings → API Tokens** (scope it to projects, tasks, labels, task comments, attachments, assignees, relations, subscriptions, reactions and users — tools whose scope is missing return a 401).
2. Run the interactive setup once:

   ```bash
   npx -y @fswap/mcp-vikunja@latest setup
   ```

   It asks for your Vikunja URL and token, verifies them against `/api/v1/user`, lets you pick a default project, and stores the answers in your OS config directory (mode `0600`).

3. Add the server to your client. Every value asked in `setup` can be skipped with Enter; anything you skip goes into the `env` block shown below instead. `setup --print` shows these snippets again at any time.

   **Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json` or `<project>/.cursor/mcp.json`):

   ```json
   {
     "mcpServers": {
       "vikunja": {
         "command": "npx",
         "args": ["-y", "@fswap/mcp-vikunja@latest"]
       }
     }
   }
   ```

   **Codex** (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.vikunja]
   command = "npx"
   args = ["-y", "@fswap/mcp-vikunja@latest"]
   ```

   **Claude Code**:

   ```bash
   claude mcp add vikunja -- npx -y @fswap/mcp-vikunja@latest
   ```

### Without `setup` (environment variables)

Environment variables take precedence over the config file, so you can skip `setup` entirely (or skip individual values in it and set them here):

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "npx",
      "args": ["-y", "@fswap/mcp-vikunja@latest"],
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
args = ["-y", "@fswap/mcp-vikunja@latest"]
[mcp_servers.vikunja.env]
VIKUNJA_URL = "https://try.vikunja.io"
VIKUNJA_API_TOKEN = "tk_..."
```

| Variable | Purpose |
|---|---|
| `VIKUNJA_URL` | Vikunja base URL (with or without `/api/v1`) |
| `VIKUNJA_API_TOKEN` | API token or login JWT |
| `VIKUNJA_ALLOW_DELETE` | `true` to expose `delete_task`, `delete_task_comment` and `delete_task_attachment` |
| `VIKUNJA_DEFAULT_PROJECT_ID` | Project used by `create_task` when `projectId` is omitted |

## Tools

| Tool | Method + endpoint | Notes |
|---|---|---|
| `list_projects` | `GET /projects` | id, title, description, parent |
| `get_project` | `GET /projects/{id}` | |
| `create_project` | `PUT /projects` | optional parent project |
| `list_tasks` | `GET /tasks` or `GET /projects/{id}/tasks` | open tasks by default; `assignedToMe`, `filter`, `sortBy`, pagination |
| `get_task` | `GET /tasks/{id}` + `GET /tasks/{id}/comments` | everything on the task page, including comments (`includeComments=false` skips them) |
| `create_task` | `PUT /projects/{id}/tasks` | all task fields, see below |
| `update_task` | `POST /tasks/{id}` (+ labels/assignees bulk) | merges your changes onto the current task |
| `complete_task` | `POST /tasks/{id}` with `done: true` | `done=false` marks undone |
| `duplicate_task` | `PUT /tasks/{id}/duplicate` | copies labels, assignees, attachments, reminders |
| `set_subscription` | `PUT` / `DELETE /subscriptions/{task\|project}/{id}` | subscribe / unsubscribe |
| `list_labels` | `GET /labels` | label ids for create/update |
| `create_label` | `PUT /labels` | |
| `get_current_user` | `GET /user` | your own user id, e.g. to assign yourself |
| `find_users` | `GET /projects/{id}/projectusers` or `GET /users` | user ids for `assigneeIds` |
| `list_task_comments` | `GET /tasks/{id}/comments` | author, HTML body, reactions |
| `add_task_comment` | `PUT /tasks/{id}/comments` | plain text is wrapped in `<p>` |
| `update_task_comment` | `POST /tasks/{id}/comments/{commentId}` | |
| `set_reaction` | `PUT /{tasks\|comments}/{id}/reactions` | `remove=true` removes your reaction |
| `add_task_relation` | `PUT /tasks/{id}/relations` | subtask, parenttask, blocking, related, … |
| `remove_task_relation` | `DELETE /tasks/{id}/relations/{kind}/{otherId}` | |
| `list_task_attachments` | `GET /tasks/{id}/attachments` | |
| `upload_task_attachment` | `PUT /tasks/{id}/attachments` (multipart) | local file paths |
| `download_task_attachment` | `GET /tasks/{id}/attachments/{attachmentId}` | saves to disk; small images/text returned inline |
| `list_kanban_buckets` | `GET /projects/{id}/views` + `/views/{view}/buckets` | kanban columns |
| `move_task_to_bucket` | `POST /projects/{id}/views/{view}/buckets/{bucket}/tasks` | |
| `delete_task` | `DELETE /tasks/{id}` | only when delete is allowed (setup answer or `VIKUNJA_ALLOW_DELETE=true`) |
| `delete_task_comment` | `DELETE /tasks/{id}/comments/{commentId}` | delete-gated like `delete_task` |
| `delete_task_attachment` | `DELETE /tasks/{id}/attachments/{attachmentId}` | delete-gated like `delete_task` |

`create_task` and `update_task` cover the rest of the task menu: due/start/end dates, priority, progress (`percentDone`), colour (`hexColor`), favorite (`isFavorite`), repeating interval (`repeatAfterSeconds`, `repeatMode`), reminders (absolute or relative to a date), labels (`labelIds`), assignees (`assigneeIds`) and moving to another project (`projectId`). `labelIds`, `assigneeIds` and `reminders` replace the current values. `get_task` returns all of these plus related tasks, attachments, kanban buckets, subscription and comments.

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
npx -y @fswap/mcp-vikunja@latest setup --reset
```

## License

MIT
