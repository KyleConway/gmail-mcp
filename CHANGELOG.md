# Changelog

## 0.4.0 (fork of mkpoli/gmail-mcp)

The first release of this fork, based on upstream [mkpoli/gmail-mcp](https://github.com/mkpoli/gmail-mcp) at 88531e9 (0.3.0 plus two OAuth expiry fixes). It narrows the server to one use, a personal Gmail connector for Claude, and fixes the findings of a security review: 2 high, 11 medium and 3 low.

### Sign-in

- Registration and `/authorize` accept only exact, allowlisted redirect URIs. By default these are Claude's two callbacks.
- New optional `ALLOWED_REDIRECT_URIS` var: an exact, comma-separated list that replaces the default.
- New `PIN_FIRST_CLIENT` var (default `"true"`): each Google account is pinned to the first OAuth client that completes a sign-in for it, and other clients get a 403 explaining how to reset. `ALLOWED_CLIENT_IDS` overrides it.
- New optional `ALLOWED_CLIENT_IDS` secret: pins sign-in to exact client ids.
- PKCE with S256 is required.
- Approval forms expire after 10 minutes and are re-checked on POST.
- `/authorize`, `/callback` and `/register` are rate-limited per IP, with IPv6 keyed by /64.
- Each sign-in retires the account's grants from other clients.
- Grants and client registrations last 10 years (`CONNECTION_TTL_SECONDS`). Upstream's later fix chose one year and never-expiring registrations; this fork keeps a finite lifetime for both.

### Mail

- `reply_all` and `send_draft` require a `recipients` list of bare addresses, and refuse unless it matches who the mail would reach (To, Cc, Bcc and Reply-To).
- Address parsing ignores display names and comments, and strict mode refuses ambiguous or obsolete-syntax entries.
- Summaries show Reply-To and Bcc.
- `update_draft` no longer re-splits decoded display names.
- A reply draft keeps the caller's Cc.
- The label tools refuse TRASH and SPAM.
- Every tool declares MCP annotations (readOnlyHint, destructiveHint, openWorldHint).

### Attachments

- `/upload/` and `/download/` secrets are HMACs of their own address, checked before any Durable Object wakes.
- A download link serves one fetch within 10 minutes (was: any number for an hour).
- The origin used in capability links is learned only from authenticated MCP traffic.

### Operations

- Workers invocation logs and traces are off, because they would store tool arguments.
- `MAX_ACCOUNTS` defaults to `"1"` in `wrangler.jsonc`.
- `bun run deploy` and `bun run dev` regenerate `wrangler.local.jsonc` from `wrangler.jsonc` first (`bun run setup --sync`), so edits made after `bun run setup` are no longer silently left out of deploys.

### Documentation and packaging

- New README for the fork, a step-by-step [docs/SETUP.md](./docs/SETUP.md), [SECURITY.md](./SECURITY.md), and a contributor guide in CLAUDE.md.
- The guide served at `/` describes adding a claude.ai custom connector instead of `claude mcp add`, which this fork refuses by default.
- Removed the Japanese and Chinese READMEs and their images. They described upstream's behavior, which no longer matches this fork, and the upstream versions remain available there.
- Removed the comparison table and image, which described upstream and Claude's connectors as they were.
- Removed `server.json` and `lhm.plugin.json`, upstream's registry manifests. They named upstream's registry identity and listed upstream's tool schemas, which this fork has changed. They can be recreated under `io.github.KyleConway/gmail-mcp` if the fork is ever listed in a registry.
- `package.json` points at KyleConway/gmail-mcp, credits mkpoli as the original author, and drops upstream's `mcpName`.
- Tests use neutral, made-up names and addresses.
- README, setup guide and the served guide page restyled (periwinkle and deep purple, monospace labels, numbered steps) and rewritten in a conversational voice. The README's security-model section is gone; CHANGELOG and SECURITY.md carry the detail.
- Removed upstream's logo, demo and architecture images, the demo video, and `scripts/render-assets.ts`, which generated them. The README now uses the cards in `docs/cards/`.
