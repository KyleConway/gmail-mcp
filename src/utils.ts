// A stalled call to Google would hold the session object open for as long as
// the connection lasts, so these give up on the same terms the Gmail calls do.
const GOOGLE_TIMEOUT_MS = 30_000;

// Context from the auth process, encrypted and stored inside the MCP token grant,
// provided to the agent as this.props.
export type Props = {
	email: string;
	name: string;
	accessToken: string;
	refreshToken: string;
	// Unix ms when accessToken expires.
	expiresAt: number;
};

// The MCP endpoint is public and clients self-register, so who may finish a
// Google sign-in is decided by ALLOWED_EMAILS. Patterns, comma-separated:
//   user@example.com  a single account
//   *@example.com     any account in that domain
//   *                 any verified Google account, making the server a relay
//                     anyone may bind to their own mailbox
// An empty setting admits no one. A grant only ever reaches the mailbox that
// authenticated it, so a wider list never widens access to existing accounts.
export function isEmailAllowed(email: string, allowList: string | undefined): boolean {
	const address = email.trim().toLowerCase();
	const at = address.indexOf("@");
	if (at < 0) return false;
	const domain = address.slice(at);
	const patterns = (allowList ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	return patterns.some(
		(p) => p === "*" || p === address || (p.startsWith("*@") && p.slice(1) === domain),
	);
}

// A deployment that admits a whole domain, or anyone, should still not admit
// an unbounded number of accounts: Google caps unverified apps at 100 users,
// and every grant consumes the deployment's own quota afterwards. Accounts
// already admitted keep working once the cap is reached; only new ones stop.
export function isUnderAccountCap(knownAccounts: number, isNewAccount: boolean, cap: number) {
	if (!isNewAccount) return true;
	if (!Number.isFinite(cap) || cap <= 0) return false;
	return knownAccounts < cap;
}

export function parseLimit(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Claude's apps finish every sign-in on one of these, and nothing else is
// meant to sign in here. The provider only checks a redirect against what the
// client registered for itself, and open registration lets anyone choose
// that, so the comparison is with the whole string: a look-alike host, an
// app scheme or a userinfo prefix all fail it.
const CLAUDE_CALLBACKS = new Set([
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
]);

export function isClaudeRedirect(uri: string): boolean {
	return CLAUDE_CALLBACKS.has(uri);
}

// ALLOWED_REDIRECT_URIS replaces Claude's two callbacks with the operator's own
// list, comma-separated, for a deployment that serves some other MCP client.
// Each entry is compared with the whole redirect, character for character:
// a pattern or a prefix would let a look-alike path or host through, which is
// exactly what this check exists to stop. An unset or empty setting keeps the
// Claude-only default, so a typo that empties the list cannot open sign-in to
// every redirect. Every entry added is one more place an authorization code
// can be sent, and a localhost entry hands codes to whatever process on the
// signing-in machine listens on that port.
export function allowedRedirects(raw: string | undefined): ReadonlySet<string> {
	const listed = (raw ?? "")
		.split(",")
		.map((uri) => uri.trim())
		.filter(Boolean);
	return listed.length > 0 ? new Set(listed) : CLAUDE_CALLBACKS;
}

export function isAllowedRedirect(uri: string, raw: string | undefined): boolean {
	return allowedRedirects(raw).has(uri);
}

// The provider refuses only a handful of dangerous schemes in a registered
// redirect, so a client naming any other host or an app scheme would register
// and stay in KV for the decade a registration lasts. /authorize refuses such a
// redirect anyway, so the client could never sign in, and refusing it here
// keeps it out of KV. One allowed callback among several is enough, so a URI
// Claude adds to its list later cannot lock the owner out.
export function registrationRefusal(
	redirectUris: unknown,
	raw: string | undefined,
): { description: string } | undefined {
	if (
		Array.isArray(redirectUris) &&
		redirectUris.some((uri) => typeof uri === "string" && isAllowedRedirect(uri, raw))
	) {
		return undefined;
	}
	return {
		description: raw?.trim()
			? "This server only registers clients whose callback is in ALLOWED_REDIRECT_URIS, and none was listed."
			: "This server only registers Claude, and no Claude callback was listed.",
	};
}

// Registration stays open because Claude registers a client of its own on each
// fresh connection, and a client registered from someone else's Claude account
// returns to the same callback as the owner's. Once the owner's connector has
// registered, ALLOWED_CLIENT_IDS can name its id (comma-separated for more than
// one), and any other client is refused before it reaches a dialog someone
// could be talked into approving. Unlike ALLOWED_EMAILS, an empty setting pins
// nothing.
export function isClientAllowed(clientId: string, allowList: string | undefined): boolean {
	const ids = (allowList ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	return ids.length === 0 || ids.includes(clientId);
}

// Without ALLOWED_CLIENT_IDS, anyone holding the URL can register a client and
// send the owner a link to approve it. Pinning each account to the first client
// that completes a sign-in for it closes that once the owner has connected,
// with nothing to copy into a secret. It is on unless PIN_FIRST_CLIENT says
// otherwise, so a deployment that never set it is pinned rather than open.
// An explicit ALLOWED_CLIENT_IDS is the operator choosing for themselves, and
// it takes over entirely.
export function isAutoPinEnabled(
	pinFirstClient: string | undefined,
	allowedClientIds: string | undefined,
): boolean {
	const listed = (allowedClientIds ?? "").split(",").some((id) => id.trim() !== "");
	if (listed) return false;
	const flag = (pinFirstClient ?? "").trim().toLowerCase();
	return !["false", "0", "no", "off"].includes(flag);
}

// One key per account, apart from the account: markers the cap counts. The
// address is lowercased for the same reason the marker's is: Google may report
// one mailbox in either case.
export function pinKey(email: string): string {
	return `pin:${email.trim().toLowerCase()}`;
}

// Limits are counted per caller address, but one IPv6 subscriber is routinely
// handed a whole /64, and keyed on the full address that caller would get a
// fresh allowance for every address in it. The first four groups are what
// identify it. Anything that does not read as plain IPv6 is keyed as it came,
// which is what an IPv4 address needs, and keeps an IPv4-mapped address from
// sharing one bucket with every other.
export function rateLimitKey(request: Request): string {
	const address = request.headers.get("cf-connecting-ip") ?? "unknown";
	const halves = address.toLowerCase().split("::");
	if (!address.includes(":") || halves.length > 2) return address;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	const gap = halves.length === 2 ? Math.max(8 - head.length - tail.length, 0) : 0;
	const groups = [...head, ...Array.from({ length: gap }, () => "0"), ...tail];
	if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
		return address;
	}
	const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16));
	return `${prefix.join(":")}::/64`;
}

export function getGoogleAuthorizeUrl({
	client_id,
	redirect_uri,
	scope,
	state,
}: {
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
}) {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", client_id);
	url.searchParams.set("redirect_uri", redirect_uri);
	url.searchParams.set("scope", scope);
	url.searchParams.set("state", state);
	url.searchParams.set("response_type", "code");
	// Required to receive a refresh token; without prompt=consent Google
	// omits it on re-authorization of an already-granted client.
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return url.href;
}

export type GoogleTokens = {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	// What the account actually granted, which is not always what was asked for.
	scope?: string;
};

export async function exchangeGoogleCode({
	client_id,
	client_secret,
	code,
	redirect_uri,
}: {
	client_id: string;
	client_secret: string;
	code: string | undefined;
	redirect_uri: string;
}): Promise<[GoogleTokens, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}
	const resp = await fetch("https://oauth2.googleapis.com/token", {
		signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id,
			client_secret,
			code,
			redirect_uri,
			grant_type: "authorization_code",
		}).toString(),
	});
	if (!resp.ok) {
		const detail = await readBoundedText(resp.body);
		console.error("google token exchange failed:", resp.status, detail);
		// Google refuses a spent, mismatched or expired code with a 4xx. Passing
		// that back as a server fault tells the person signing in to wait for a
		// fix that is not coming; what they need to do is start again.
		return [
			null,
			resp.status >= 400 && resp.status < 500
				? new Response("Google refused this sign-in. Start the connection again.", { status: 400 })
				: new Response("Failed to exchange authorization code", { status: 502 }),
		];
	}
	const tokens = (await resp.json()) as GoogleTokens;
	if (!tokens.access_token) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [tokens, null];
}

export async function refreshGoogleToken({
	client_id,
	client_secret,
	refresh_token,
}: {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}): Promise<GoogleTokens> {
	const resp = await fetch("https://oauth2.googleapis.com/token", {
		signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id,
			client_secret,
			refresh_token,
			grant_type: "refresh_token",
		}).toString(),
	});
	if (!resp.ok) {
		const detail = await readBoundedText(resp.body);
		// invalid_grant is the refresh token itself dying, and every tool call
		// fails on it identically until the account signs in again. Naming the
		// ways it dies turns a wall of identical failures into the action that
		// ends them: a password change revokes every Gmail-scoped token the
		// account has issued, revoking the app by hand does the same, and an
		// OAuth app left in Testing has each sign-in expire after seven days.
		if (detail.includes("invalid_grant")) {
			throw new Error(
				"Google no longer accepts this account's sign-in. Reconnect this MCP server and sign in again. This follows a password change (Google revokes Gmail tokens with it) or a revocation at https://myaccount.google.com/connections; when it recurs every 7 days, the deployment's OAuth app is in Testing — publish it to In production at https://console.cloud.google.com/auth/overview.",
			);
		}
		throw new Error(`google token refresh failed: ${resp.status} ${detail}`);
	}
	const tokens = (await resp.json()) as GoogleTokens;
	if (!tokens.access_token || typeof tokens.expires_in !== "number") {
		throw new Error("google token refresh returned no usable access token");
	}
	return tokens;
}

export async function fetchGoogleUserInfo(accessToken: string) {
	const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
		signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!resp.ok) {
		throw new Error(`userinfo failed: ${resp.status}`);
	}
	const info = (await resp.json()) as {
		email?: string;
		verified_email?: boolean;
		name?: string;
	};
	if (!info.email || typeof info.email !== "string") {
		throw new Error("userinfo returned no email");
	}
	// Only an explicit true counts: an absent field is not evidence of ownership.
	return { email: info.email, verified: info.verified_email === true, name: info.name };
}

// A sender that declares no length would otherwise decide how much memory a
// request occupies, so the body is counted as it arrives and refused part-way
// rather than after it has all been held.
export class BodyTooLarge extends Error {}

// What an error response is worth reading. The peer decides how much it sends,
// and a diagnostic that has to be held whole before it can be trimmed is one
// the sender chose the size of.
export const MAX_ERROR_BYTES = 4_000;

export async function readBoundedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
	const reader = body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
		if (total >= MAX_ERROR_BYTES) {
			await reader.cancel();
			break;
		}
	}
	const joined = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(joined.subarray(0, MAX_ERROR_BYTES));
}

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new BodyTooLarge();
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}
