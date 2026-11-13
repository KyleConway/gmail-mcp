import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import setupGuide from "../docs/index.html";
import {
	BodyTooLarge,
	exchangeGoogleCode,
	fetchGoogleUserInfo,
	getGoogleAuthorizeUrl,
	isAllowedRedirect,
	isAutoPinEnabled,
	isClientAllowed,
	isEmailAllowed,
	isUnderAccountCap,
	type Props,
	parseLimit,
	pinKey,
	rateLimitKey,
	readBoundedBody,
} from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
	verifyApprovalState,
} from "./workers-oauth-utils";

// gmail.modify covers read, search, labels, trash, drafts, and send,
// while excluding permanent deletion and account settings.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GOOGLE_SCOPE = [
	GMAIL_SCOPE,
	EMAIL_SCOPE,
	"https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

// An approval post carries a base64 state blob and a token, measured in
// kilobytes. The ceiling is what separates that from a body sent to occupy the
// isolate's memory.
const MAX_APPROVAL_BODY_BYTES = 64 * 1024;

// A signed approval form is otherwise good for ever, and one fetched once could
// be posted back for a fresh state and a KV write as often as anyone liked. It
// lasts as long as the CSRF cookie that goes with it.
const APPROVAL_TTL_MS = 10 * 60 * 1000;

async function readBoundedForm(request: Request, limit: number): Promise<FormData> {
	const body = await readBoundedBody(request, limit);
	return new Request(request.url, { method: "POST", headers: request.headers, body }).formData();
}

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// The deployment documents itself: visiting the domain explains what this
// server is and how to connect a client to it. The Text module rule in
// wrangler.jsonc inlines the file as a string; bun's own ambient types
// describe .html imports as bundles, hence the cast.
const guide = setupGuide as unknown as string;

app.get(
	"/",
	() =>
		new Response(guide, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		}),
);

// The sign-in steps answer anyone holding the URL, and each spends KV: an
// approval or an auto-approved GET stores a state, and the callback reads and
// deletes one. Metering them by caller before any handler runs bounds how fast
// a replay loop can spend the writes that connected accounts' tokens need.
// This sits on the router rather than in the Worker's wrapper, where /register
// is metered, because Hono decodes a path before matching it: /%61uthorize
// reaches the same handler as /authorize, and a check on the raw path would
// let it by.
for (const path of ["/authorize", "/callback"]) {
	app.use(path, async (c, next) => {
		if (c.env.REGISTER_LIMITER) {
			const { success } = await c.env.REGISTER_LIMITER.limit({ key: rateLimitKey(c.req.raw) });
			if (!success) {
				return c.text("Too many sign-in attempts. Wait a minute, then connect again.", 429);
			}
		}
		await next();
	});
}

// What /authorize will not sign in, whoever asks. GET checks a request before
// it shows the dialog or auto-approves, and POST checks the signed copy again,
// so a form signed before a check existed, or before the pin was set, is held
// to the same terms.
function refusalFor(
	oauthReqInfo: AuthRequest,
	settings: { ALLOWED_CLIENT_IDS?: string; ALLOWED_REDIRECT_URIS?: string },
): { status: 400 | 403; message: string } | null {
	const allowedClientIds = settings.ALLOWED_CLIENT_IDS;
	// A code sent anywhere but Claude, or the operator's own list, is a code
	// someone else redeems.
	if (!isAllowedRedirect(oauthReqInfo.redirectUri, settings.ALLOWED_REDIRECT_URIS)) {
		return {
			status: 400,
			message: settings.ALLOWED_REDIRECT_URIS?.trim()
				? "This server only signs in clients whose callback is listed in ALLOWED_REDIRECT_URIS."
				: "This server only signs in Claude.",
		};
	}
	// The id is echoed because whoever is refused here is most often the owner
	// after reconnecting, and this page is the handiest place to read it. The
	// last sentence is for the times it is someone the owner was sent by.
	if (!isClientAllowed(oauthReqInfo.clientId, allowedClientIds)) {
		const id = oauthReqInfo.clientId;
		return {
			status: 403,
			message: `This server is pinned to the OAuth clients listed in ALLOWED_CLIENT_IDS, and client ${id} is not one of them. If this sign-in began at Claude's own Connect button, the connector has registered as a new client: run \`wrangler secret put ALLOWED_CLIENT_IDS\` and enter ${id}, after any ids to keep and separated by commas, then connect again. If it began at a link someone sent you, close this page.`,
		};
	}
	// Claude registers as a public client with no secret, so the PKCE challenge
	// is all that ties a code to the request that asked for it. The provider
	// lets a request without one through and compares a method it does not
	// know as plain; Claude always sends S256 with a challenge.
	if (!oauthReqInfo.codeChallenge || oauthReqInfo.codeChallengeMethod !== "S256") {
		return { status: 400, message: "This server requires PKCE with S256." };
	}
	return null;
}

app.get("/authorize", async (c) => {
	// Clients register themselves via /register (dynamic client registration),
	// and parseAuthRequest throws on a client_id it has never issued. A foreign
	// client_id usually means external OAuth credentials were pasted into the
	// MCP client's connector settings.
	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch (error) {
		console.error("GET /authorize parse error:", error);
		return c.text(
			"Unknown or invalid OAuth client. Connect without entering any client ID or secret — this server registers MCP clients automatically.",
			400,
		);
	}
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}
	// Ahead of the dialog and the auto-approve alike. The steps after them act on
	// this same request, carried in the signed form or the stored state.
	const refusal = refusalFor(oauthReqInfo, c.env);
	if (refusal) {
		return c.text(refusal.message, refusal.status);
	}

	const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId).catch(() => null);
	if (!client) {
		return c.text(
			"Unknown OAuth client. Connect without entering any client ID or secret — this server registers MCP clients automatically.",
			400,
		);
	}

	if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		const headers = new Headers();
		headers.append("Set-Cookie", sessionBindingCookie);
		return redirectToGoogle(c.req.raw, stateToken, headers);
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return await renderApprovalDialog(c.req.raw, {
		client,
		csrfToken,
		server: {
			description:
				"Remote MCP server for Gmail. Signing in grants the connecting MCP client access to the chosen Google account's mailbox.",
			// Google's screen lists each permission with its own tick box, and an
			// unticked Gmail line only comes to light after the redirect back.
			// Saying so now is the one chance to prevent that round trip.
			consentNote:
				"Google will ask which permissions to share. Leave every box ticked — without the Gmail one this connection cannot reach any mail.",
			name: "Gmail MCP",
		},
		setCookie,
		cookieSecret: env.COOKIE_ENCRYPTION_KEY,
		state: { oauthReqInfo, issuedAt: Date.now() },
	});
});

app.post("/authorize", async (c) => {
	try {
		// Anyone can post here, and the CSRF token checked below travels in the
		// body, so the body has to be read before it can be trusted. It is read
		// a chunk at a time against a ceiling rather than on a declared length,
		// which a chunked request simply omits.
		let formData: FormData;
		try {
			formData = await readBoundedForm(c.req.raw, MAX_APPROVAL_BODY_BYTES);
		} catch (error: unknown) {
			// Reading and parsing happen together, and the two failures deserve
			// different answers: one says the body was too big, the other that it
			// was not a form at all.
			return error instanceof BodyTooLarge
				? c.text("Request body too large", 413)
				: c.text("Invalid form data", 400);
		}
		const csrfClearCookie = validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		// Only a blob this server signed is acted on. Without this the POST would
		// grant whatever the form said — another client, or the same one with its
		// PKCE challenge removed — while the dialog named something else.
		const verified = await verifyApprovalState(encodedState, env.COOKIE_ENCRYPTION_KEY);
		if (verified === null) {
			return c.text("Invalid state data", 400);
		}
		let state: { oauthReqInfo?: AuthRequest; issuedAt?: number };
		try {
			state = JSON.parse(verified);
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo?.clientId) {
			return c.text("Invalid request", 400);
		}
		// A form signed before it carried a time has no age to check, and is
		// refused like one that is too old.
		if (typeof state.issuedAt !== "number" || Date.now() - state.issuedAt > APPROVAL_TTL_MS) {
			return c.text("This approval has expired. Start the connection again from Claude.", 400);
		}
		const refusal = refusalFor(state.oauthReqInfo, c.env);
		if (refusal) {
			return c.text(refusal.message, refusal.status);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Set-Cookie headers must stay separate; collapsing them through a
		// plain object joins the values and breaks both cookies.
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);
		headers.append("Set-Cookie", csrfClearCookie.clearCookie);

		return redirectToGoogle(c.req.raw, stateToken, headers);
	} catch (error: unknown) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}
});

// A sign-in that came back missing something ends on this page rather than on
// a bare error line. The state that brought the browser here was spent on
// arrival, so the button carries a fresh one, bound to this session the same
// way the first was — Google's screen reopens directly, with nothing to
// restart on the client side.
async function consentRetry(
	request: Request,
	kv: KVNamespace,
	oauthReqInfo: AuthRequest,
	status: number,
	problem: string,
	fix: string,
): Promise<Response> {
	const { stateToken } = await createOAuthState(oauthReqInfo, kv);
	const { setCookie } = await bindStateToSession(stateToken);
	const retryUrl = getGoogleAuthorizeUrl({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: new URL("/callback", request.url).href,
		scope: GOOGLE_SCOPE,
		state: stateToken,
	}).replace(/&/g, "&amp;");
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gmail MCP | Sign-in incomplete</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         line-height: 1.6; color: #333; background: #f9fafb; margin: 0; }
  .card { max-width: 560px; margin: 3rem auto; background: #fff; border-radius: 8px;
          box-shadow: 0 8px 36px 8px rgba(0, 0, 0, 0.1); padding: 2rem; }
  h1 { font-size: 1.3rem; font-weight: 500; margin-top: 0; }
  .fix { background: #fff8e1; border: 1px solid #f0dfa0; border-radius: 6px;
         padding: 0.75rem 1rem; color: #6b5900; }
  .button { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; border-radius: 6px;
            background: #0070f3; color: #fff; text-decoration: none; font-weight: 500; }
  a { color: #0070f3; }
</style>
</head>
<body>
<div class="card">
  <h1>Sign-in incomplete</h1>
  <p>${problem}</p>
  <p class="fix">${fix}</p>
  <a class="button" href="${retryUrl}">Choose permissions again</a>
</div>
</body>
</html>`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Set-Cookie": setCookie,
		},
	});
}

// Every fresh connection registers a new client, and completeAuthorization
// retires only the earlier grants of the client signing in. Any other grant,
// from a connector removed and added again or from an approval someone was
// talked into, would go on refreshing for the ten years a grant now lasts, and
// enough of them would push a sign-in past the Free plan's subrequest limit.
// This deployment keeps one connection per account, so a sign-in retires the
// rest. It runs once the sign-in has succeeded, and a failure here leaves those
// grants as they were rather than failing it.
async function retireOtherGrants(provider: OAuthHelpers, userId: string, clientId: string) {
	try {
		const stale: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await provider.listUserGrants(userId, cursor ? { cursor } : undefined);
			for (const grant of page.items) {
				if (grant.clientId !== clientId) stale.push(grant.id);
			}
			cursor = page.cursor;
		} while (cursor);
		const results = await Promise.allSettled(stale.map((id) => provider.revokeGrant(id, userId)));
		const failed = results.filter((result) => result.status === "rejected").length;
		if (failed > 0) {
			console.warn(`could not retire ${failed} of ${stale.length} earlier grants`);
		}
	} catch (error) {
		console.warn("could not retire earlier grants:", error);
	}
}

// The person refused here has just proven they own an allowed account, so this
// is most often the owner after removing and re-adding the connector, and the
// page says how to move the pin. The last sentence is for the times it is not.
function pinnedRefusal(pin: string, clientId: string): string {
	return [
		`This Google account is pinned to the first OAuth client that completed a sign-in for it, and this sign-in came from a different client, ${clientId}. Nothing was stored.`,
		`If you removed and re-added this connector in Claude, reset the pin and connect again: run \`wrangler kv key delete "${pin}" --namespace-id <OAUTH_KV id> --remote\` (\`wrangler kv namespace list\` shows the id), or set ALLOWED_CLIENT_IDS to ${clientId} with \`wrangler secret put ALLOWED_CLIENT_IDS\`, which replaces the automatic pin.`,
		"If this sign-in began at a link someone sent you, close this page and change nothing.",
	].join("\n\n");
}

function redirectToGoogle(request: Request, stateToken: string, headers?: Headers) {
	const h = new Headers(headers);
	h.set(
		"Location",
		getGoogleAuthorizeUrl({
			client_id: env.GOOGLE_CLIENT_ID,
			redirect_uri: new URL("/callback", request.url).href,
			scope: GOOGLE_SCOPE,
			state: stateToken,
		}),
	);
	return new Response(null, { headers: h, status: 302 });
}

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: unknown) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	const [tokens, errResponse] = await exchangeGoogleCode({
		client_id: c.env.GOOGLE_CLIENT_ID,
		client_secret: c.env.GOOGLE_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
	});
	if (errResponse) return errResponse;
	// The consent screen lets an account tick the Gmail permission off and
	// approve the rest. That grant looks complete here and fails on the first
	// tool call instead, so it is refused now while the reason is still legible.
	const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
	if (granted.length > 0 && !granted.includes(GMAIL_SCOPE)) {
		return consentRetry(
			c.req.raw,
			c.env.OAUTH_KV,
			oauthReqInfo,
			403,
			"The Gmail permission was left unticked on Google's screen, so this connection could reach no mail. Nothing was stored.",
			"On the list of permissions, leave every box ticked — the Gmail one is the connection's whole purpose. It sits below the account picker and above the Continue button.",
		);
	}
	// The address is what the allowlist, the account cap, the session owner and
	// the stored grant are all keyed by, so a consent that leaves it out cannot
	// finish. Saying so here beats the lookup failing a moment later with
	// nothing the person signing in can act on.
	if (granted.length > 0 && !granted.includes(EMAIL_SCOPE)) {
		return consentRetry(
			c.req.raw,
			c.env.OAUTH_KV,
			oauthReqInfo,
			403,
			"The email permission was withheld, and the address is what a connection is keyed by. Nothing was stored.",
			"On the list of permissions, leave every box ticked, the email address included.",
		);
	}
	if (!tokens.refresh_token) {
		return consentRetry(
			c.req.raw,
			c.env.OAUTH_KV,
			oauthReqInfo,
			400,
			"Google sent no refresh token, which is what keeps a connection signed in past the first hour.",
			'Remove this app\'s earlier access at <a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a>, then choose the account again.',
		);
	}

	try {
		const user = await fetchGoogleUserInfo(tokens.access_token);

		if (!user.verified || !isEmailAllowed(user.email, c.env.ALLOWED_EMAILS)) {
			return c.text("This Google account is not allowed on this server", 403);
		}

		// The pin is checked once Google has said whose account this is, since
		// nothing before that knows, and ahead of anything stored for the sign-in.
		// claude.ai registers two clients for each Connect and completes sign-in
		// with only one of them, so a client is pinned for having finished a
		// sign-in, never for registering: the one that never finishes must not
		// lock out the one that does.
		const pinning = isAutoPinEnabled(c.env.PIN_FIRST_CLIENT, c.env.ALLOWED_CLIENT_IDS);
		const pin = pinKey(user.email);
		const pinned = pinning ? await c.env.OAUTH_KV.get(pin) : null;
		if (pinned && pinned !== oauthReqInfo.clientId) {
			return c.text(pinnedRefusal(pin, oauthReqInfo.clientId), 403);
		}

		// Count the accounts this deployment has ever admitted, and stop new ones
		// past the cap. The marker doubles as the "is this account new" answer.
		const marker = `account:${user.email.toLowerCase()}`;
		const seen = await c.env.OAUTH_KV.get(marker);
		if (!seen) {
			const known = await c.env.OAUTH_KV.list({ prefix: "account:", limit: 1000 });
			// A KV listing stops at 1000 keys. Past that the count understates how
			// many accounts exist, and a cap set above it would never be reached,
			// so an incomplete listing counts as unbounded and turns the account away.
			const admitted = known.list_complete ? known.keys.length : Number.POSITIVE_INFINITY;
			if (!isUnderAccountCap(admitted, true, parseLimit(c.env.MAX_ACCOUNTS, 25))) {
				console.warn("account cap reached; refused a new sign-in");
				return c.text(
					"This server has reached its limit of connected accounts. Ask its operator to raise MAX_ACCOUNTS.",
					429,
				);
			}
		}
		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: user.email,
			},
			props: {
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				expiresAt: Date.now() + tokens.expires_in * 1000,
				email: user.email,
				name: user.name ?? user.email,
			} as Props,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: user.email,
		});

		// Recorded once the grant exists. Written before it, a sign-in that failed
		// here would leave the account counted against the cap for ever without
		// ever having connected.
		await c.env.OAUTH_KV.put(marker, new Date().toISOString());
		// After the grant for the same reason: a pin written ahead of a sign-in
		// that then failed would hold the account for a client that never
		// connected.
		if (pinning && !pinned) {
			await c.env.OAUTH_KV.put(pin, oauthReqInfo.clientId);
		}

		await retireOtherGrants(c.env.OAUTH_PROVIDER, user.email, oauthReqInfo.clientId);

		const headers = new Headers({ Location: redirectTo });
		if (clearSessionCookie) {
			headers.set("Set-Cookie", clearSessionCookie);
		}

		return new Response(null, { status: 302, headers });
	} catch (error) {
		console.error("GET /callback error:", error);
		return c.text("Internal server error", 500);
	}
});

export { app as GoogleHandler };
