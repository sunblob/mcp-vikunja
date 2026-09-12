# Releasing

Versions are published to npm by GitHub Actions when a `v*` tag is pushed.
Authentication uses npm **trusted publishing** (OIDC), so no token is stored in the repo.

## One-time setup

1. **First publish is manual** — npm only lets you attach a trusted publisher to a package that already exists:

   ```bash
   npm login
   npm publish --access public
   ```

2. On npmjs.com open the package → **Settings** → **Trusted Publisher** → *GitHub Actions* and enter:

   | Field | Value |
   |---|---|
   | Organization or user | `sunblob` (update here and in `package.json` when the repo moves to the fswap org) |
   | Repository | `mcp-vikunja` |
   | Workflow filename | `release.yml` |
   | Environment | leave empty |

3. Make sure the `repository.url` field in `package.json` points at the same GitHub repo. Provenance verification fails if it does not match.

## Every release

```bash
npm version patch        # or minor / major — bumps package.json and creates the tag
git push --follow-tags
```

The **Release** workflow then verifies that the tag equals the package version, runs `npm run check`, and publishes with provenance. Check the run under the *Actions* tab; the npm package page will show a *Provenance* badge linking to the commit.

## Unpublishing

npm allows `npm unpublish <pkg>@<version>` within 72 hours of publishing. After that, use `npm deprecate` instead.
