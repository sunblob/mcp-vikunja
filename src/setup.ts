import * as p from "@clack/prompts";
import { saveConfig, deleteConfig, configPath, readConfigFile, PACKAGE_NAME, type StoredConfig } from "./config.js";
import { currentUser, makeClient } from "./client.js";
import type { Project } from "./tools/projects.js";
import { clientSnippets, ENV_URL, ENV_TOKEN, type MissingEnv } from "./snippets.js";

function abort(): never {
  p.cancel("Setup aborted.");
  process.exit(1);
}

function printSnippets(missing: MissingEnv): void {
  for (const s of clientSnippets(missing)) p.note(s.body, s.title);
}

export async function runSetup(args: string[] = []): Promise<void> {
  if (args.includes("--reset")) {
    const removed = deleteConfig();
    console.log(removed ? `Removed ${configPath()}` : `Nothing to remove (${configPath()} does not exist)`);
    return;
  }

  const existing = readConfigFile() ?? {};

  if (args.includes("--print")) {
    const missing: MissingEnv = {};
    if (!existing.url) missing[ENV_URL] = "https://try.vikunja.io";
    if (!existing.token) missing[ENV_TOKEN] = "tk_...";
    printSnippets(missing);
    return;
  }

  p.intro(`${PACKAGE_NAME} setup`);
  p.log.info("Press Enter to skip any value. Skipped values can be supplied later via the env block of your MCP client config.");

  const creds = await p.group(
    {
      url: () =>
        p.text({
          message: `Vikunja URL (${ENV_URL})`,
          placeholder: "https://try.vikunja.io  — Enter to skip",
          initialValue: existing.url ?? "",
          validate: (v) => (!v || /^https?:\/\/\S+$/.test(v) ? undefined : "Must start with http:// or https://"),
        }),
      token: () =>
        p.password({
          message: `API token (${ENV_TOKEN}; Settings → API Tokens in Vikunja) — Enter to skip`,
          mask: "▪",
        }),
    },
    { onCancel: abort },
  );

  const url = (creds.url ?? "").trim().replace(/\/+$/, "") || undefined;
  const token = (creds.token ?? "").trim() || existing.token || undefined;

  let defaultProjectId: number | null = existing.defaultProjectId ?? null;

  if (url && token) {
    const s = p.spinner();
    s.start("Checking connection");
    try {
      const me = await currentUser(url, token);
      s.stop(`ok (logged in as ${me.username})`);
    } catch (err) {
      s.stop("failed");
      p.cancel(`Could not authenticate: ${(err as Error).message}`);
      process.exit(1);
    }

    // Offer a default project so create_task can omit projectId.
    try {
      const projects = await makeClient(url, token).get<Project[]>("/projects", { per_page: 100 });
      if (projects.length > 0) {
        const choice = await p.select<number | null>({
          message: "Default project for new tasks (optional)",
          initialValue: defaultProjectId,
          options: [
            { value: null, label: "None — always require projectId" },
            ...projects.map((pr) => ({ value: pr.id, label: pr.title, hint: `#${pr.id}` })),
          ],
        });
        if (typeof choice === "symbol") abort();
        defaultProjectId = choice;
      }
    } catch (err) {
      p.log.warn(`Could not list projects (${(err as Error).message}); skipping default project.`);
    }
  } else {
    p.log.warn("Skipping connection check and default-project selection because URL and/or token were not provided.");
  }

  const allowDelete = await p.confirm({ message: "Allow delete tools?", initialValue: Boolean(existing.allowDelete) });
  if (typeof allowDelete === "symbol") abort();

  const config: StoredConfig = { defaultProjectId, allowDelete };
  if (url) config.url = url;
  if (token) config.token = token;
  const file = saveConfig(config);

  const missing: MissingEnv = {};
  if (!url) missing[ENV_URL] = "https://try.vikunja.io";
  if (!token) missing[ENV_TOKEN] = "tk_...";

  if (Object.keys(missing).length > 0) {
    p.log.warn(
      `Still needed: ${Object.keys(missing).join(", ")}. Add them to the env block below, or run setup again.`,
    );
  }
  printSnippets(missing);
  p.outro(`Saved to ${file}`);
}
