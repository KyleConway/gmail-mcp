# Gmail MCP: contributor and agent guide

A remote MCP server for Gmail that runs on a Cloudflare Worker the user deploys themselves. Claude connects to it as a custom connector, and each connection is bound to one Google account. It is a hardened fork of https://github.com/mkpoli/gmail-mcp (MIT), which is the git remote `upstream`.

Notes about one particular deployment (its host, KV id, OAuth client, pinned client ids) belong in `DEPLOYMENT.local.md`, which is gitignored. Never put them in a tracked file.

## Commands

- Install: `bun install --frozen-lockfile`
- Lint and type-check: `bun run check` (biome, then tsrs). `bun run fix` applies biome's fixes.
- Test: `bun test`
- Build without deploying: `./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/gm-dry`
- README counts: `python3 scripts/check-counts.py` (add `--fix` to rewrite them)

Run `bun run check && bun test` and the dry run before every commit. CI runs the same steps.

## Architecture

- `src/index.ts`: the Worker entry, the `GmailMCP` Durable Object (one MCP session; every tool is registered here), and the `OAuthProvider` configuration. The default export meters `/register`, bounds request bodies, and routes the signed `/upload/` and `/download/` file addresses.
- `src/google-handler.ts`: the Hono app behind the provider. It serves the guide at `/` (`docs/index.html`), the approval dialog at `/authorize`, and the Google sign-in return at `/callback`.
- `src/workers-oauth-utils.ts`: approval dialog rendering, CSRF, signed approval state, and the state cookie that binds a sign-in to one browser.
- `src/utils.ts`: allowlists, the account cap, rate-limit keys, Google token exchange and refresh, and bounded body readers.
- `src/gmail.ts`: Gmail REST calls, MIME building, and address parsing.
- `scripts/`: `setup.ts` (guided setup, and `--sync`), `check-counts.py` (README and guide counts), `check-render.py`.
- `docs/`: `index.html` (served at `/`), `SETUP.md` (the step-by-step guide), and `cards/` (the header and steps cards used by the README).
- `test/`: bun tests. `test/runtime-shim.ts` stands in for the `cloudflare:*` modules, and every test file that reaches the Worker imports it first.

## Configuration

Secrets, set with `wrangler secret put`:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: a Google OAuth client of type Web application.
- `COOKIE_ENCRYPTION_KEY`: `openssl rand -hex 32`. It signs approval forms, cookies and attachment links.
- `ALLOWED_EMAILS`: who may sign in (addresses, `*@domain`, or `*`). Empty admits nobody.
- `ALLOWED_CLIENT_IDS` (optional): pins sign-in to these OAuth client ids. When set, it replaces the automatic pin.

Vars in `wrangler.jsonc`:

- `MAX_ACCOUNTS`: how many distinct Google accounts may ever sign in.
- `PIN_FIRST_CLIENT` (default `"true"`): with `ALLOWED_CLIENT_IDS` unset, each account is pinned to the first OAuth client that completes a sign-in for it (KV key `pin:<lowercased address>`), and other clients are refused for that account with a 403. Reset with `wrangler kv key delete "pin:<address>" --namespace-id <id> --remote`. `"false"`, `"0"`, `"no"` or `"off"` turn it off.
- `ALLOWED_REDIRECT_URIS` (optional): exact redirect URIs, comma-separated, that replace Claude's two callbacks. Unset or empty keeps the Claude-only default. Exact match only: never add patterns or prefixes, and treat every addition, localhost above all, as a wider phishing surface.

## Security invariants

These came out of a security review. Each has tests, and none may regress without a deliberate decision recorded in the commit message and SECURITY.md.

- Sign-in is only for Claude unless the operator sets `ALLOWED_REDIRECT_URIS`. Registration and `/authorize` accept only exact, allowlisted redirect URIs (`isAllowedRedirect` in `src/utils.ts`). Look-alike hosts, app schemes and userinfo prefixes must fail.
- Without `ALLOWED_CLIENT_IDS`, an account is pinned to its first client. The pin is written only after a completed sign-in (`completeAuthorization` succeeded), never at registration: claude.ai registers two clients per Connect and completes sign-in with one, and a failed sign-in must not pin anything. The check runs in `/callback` before anything is stored.
- PKCE with S256 is required, and plain PKCE is disabled.
- Approval forms are signed, expire after 10 minutes, and are re-checked on POST against the same rules as GET.
- `/authorize`, `/callback` and `/register` are rate-limited per caller, and an IPv6 caller is keyed by its /64.
- Request bodies are counted as they arrive and refused past a ceiling, never trusted by declared length.
- Each sign-in retires the account's grants from every other client.
- `/upload/` and `/download/` secrets are HMACs of their own address and are checked before any Durable Object wakes. A download link serves one fetch within 10 minutes.
- `reply_all` and `send_draft` require the caller to list the bare recipient addresses, and refuse unless that list matches who the mail would reach (To, Cc, Bcc and Reply-To).
- Address parsing ignores display names and comments. Strict mode refuses ambiguous or obsolete-syntax entries.
- The label tools refuse TRASH and SPAM, so they cannot be used to delete or hide mail.
- Every tool carries MCP annotations (readOnlyHint, destructiveHint, openWorldHint).
- Invocation logs and traces stay off in `wrangler.jsonc`, because they would store tool arguments, which include outgoing mail.
- Grants and registrations last `CONNECTION_TTL_SECONDS` (10 years), so Claude is not signed out on a schedule.

## Deploying

1. Create the Google OAuth client and set the secrets as docs/SETUP.md describes.
2. `bun run deploy`. The first deploy provisions the KV namespace. It runs `bun run setup --sync` first, which rebuilds `wrangler.local.jsonc` from `wrangler.jsonc` when `bun run setup` has written one; a bare `wrangler deploy` would deploy that file's stale copy.
3. Add `https://<worker host>/mcp/<label>` as a custom connector in claude.ai.

Only the owner deploys. An agent working in this repo must not run `wrangler deploy`, `wrangler secret` or `wrangler kv` against a live account unless the owner asks in that session.

## Upstream sync

1. `git fetch upstream`
2. Read `git diff HEAD upstream/main -- src` with the invariants above in mind.
3. Merge, resolve, and run the checks.
4. Re-review anything that touches sign-in, redirects, tokens or recipients before deploying.

## Style

- Tabs, and biome's formatting.
- Comments explain why, in full sentences. Say what a check defends against, not what the line does.
- Tests use neutral, made-up people and reserved domains (`*.example`). Never real names or addresses.
- Never commit secrets. `.dev.vars`, `wrangler.local.jsonc` and `DEPLOYMENT.local.md` stay local.
