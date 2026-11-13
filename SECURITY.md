# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- Use GitHub's private vulnerability reporting: the **Security** tab of [KyleConway/gmail-mcp](https://github.com/KyleConway/gmail-mcp/security), then **Report a vulnerability**.
- Include what an attacker needs (the Worker URL? an approved sign-in? a crafted email?), what they gain, and a reproduction if you have one.

You should get an acknowledgement within a week. Fixes are released as soon as they are tested, with credit to the reporter unless they prefer otherwise. If the problem is also in [mkpoli/gmail-mcp](https://github.com/mkpoli/gmail-mcp), it will be reported there privately too.

Each deployment is run by its owner, so a fix only protects a deployment after its owner pulls it and runs `bun run deploy`.

## What this protects

A deployment holds a long-lived Google refresh token with the `gmail.modify` scope: read, search, send, label and trash, but not permanent deletion or account settings. Whoever holds a grant to the Worker can do all of that to the bound mailbox. The design goal is that only the owner's own Claude connector ever gets such a grant, and that Claude cannot be steered into sending mail somewhere the owner did not see.

## Threat model

### Who is assumed hostile

- **Anyone on the internet who learns the Worker URL.** Worker URLs are guessable (`gmail-mcp.<subdomain>.workers.dev`), and registration is open because Claude registers itself.
- **Anyone who can send the owner an email.** Mail content reaches Claude, so a message can carry instructions aimed at the model (prompt injection).
- **Anyone who can get the owner to click a link** while signed in to Google.

### Who is trusted

- The owner's Cloudflare account, which stores the encrypted tokens and runs the code.
- Google, and Anthropic's claude.ai callback hosts.
- The owner's judgement at Claude's tool approval prompts, for the tools set to "Needs approval".

### Attacks and defences

| Attack | Defence |
| :-- | :-- |
| Register a client whose redirect is a look-alike host or an app scheme, then phish the owner into approving it, so the code goes to the attacker | Registration and `/authorize` accept only exact, allowlisted redirect URIs: Claude's two callbacks by default, or `ALLOWED_REDIRECT_URIS`. Both GET and the signed POST check. |
| Register a client from the attacker's own claude.ai account (the real callback) and phish the owner into approving it | Each account is pinned to the first client that completed a sign-in for it (`PIN_FIRST_CLIENT`), or to `ALLOWED_CLIENT_IDS`. Any other client gets a 403 in `/callback`, before anything is stored. |
| Replay a signed approval form, or loop sign-in requests, to burn KV writes | Forms expire after 10 minutes. `/authorize`, `/callback` and `/register` are rate-limited per IP, with IPv6 keyed by /64. |
| Steal or forge a code without the PKCE verifier | PKCE with S256 is required; plain and missing challenges are refused. |
| Wake arbitrary Durable Objects, or reuse an attachment link | File addresses carry an HMAC checked before any object wakes. A download link serves one fetch within 10 minutes. |
| An email's hidden `Reply-To`, or a crafted display name, redirects a reply | `reply_all` and `send_draft` require the caller to list bare recipient addresses, and refuse unless they match every address the mail would reach. Parsing ignores display names and comments, and strict mode refuses ambiguous entries. |
| An injected instruction trashes or hides mail through the label tools | The label tools refuse TRASH and SPAM. Trash has its own tools, which carry destructive annotations so Claude can ask first. |
| Tool arguments (outgoing mail) end up in logs | Workers invocation logs and traces are off. |
| Large or slow request bodies exhaust memory | Bodies are counted as they arrive and refused past a ceiling. |

### Residual risks

These are known and accepted, or depend on the owner:

- **First client wins.** If an attacker gets the owner to approve the attacker's client before the owner ever connects their own, that client is pinned. Connect your own connector right after deploying.
- **Denial of service on the Free plan.** Anyone with the URL can spend the Free plan's 1,000 KV writes a day and take the connector offline until 00:00 UTC. Rate limits slow this; Workers Paid removes it. No data is exposed.
- **Prompt injection through mail content.** A message can still ask Claude to do things. The recipient checks and tool annotations narrow what it can achieve, and the tool approval prompts are the final check. Keep sending tools on "Needs approval", and consider blocking `forward_message`.
- **Message bodies may contain invisible characters**, and HTML that Claude writes may load remote images when the recipient opens it. Both were rated low and are not filtered.
- **Staged attachments in an abandoned session** are not swept until the session is used again.
- **The Worker sees mail in memory** while serving a request, as any hosted relay must.
- **Dependencies** (`@cloudflare/workers-oauth-provider`, the MCP SDK, `agents`, `hono`, `zod`) are on caret ranges. Keep them updated.

## Revoking access

- **Everything:** remove the app at [myaccount.google.com/connections](https://myaccount.google.com/connections), or delete the OAuth client in Google Cloud.
- **Rotating the client secret does not revoke** existing refresh tokens. Do not rely on it.
- **New sign-ins:** narrow `ALLOWED_EMAILS`, or set `ALLOWED_CLIENT_IDS`.

## Review history

Before release, the fork was reviewed in four areas (OAuth, sessions and files, tools, supply chain), with each finding checked by a second reviewer. 16 findings were confirmed and fixed: 2 high, 11 medium and 3 low. The README lists them. Invocation logging (medium) and the setup script's config snapshot (low) were also fixed. Changes to sign-in, redirects, tokens or recipient handling should be re-reviewed against the invariants in CLAUDE.md.
