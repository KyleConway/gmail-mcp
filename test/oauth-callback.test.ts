import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "./runtime-shim";

const { GoogleHandler } = await import("../src/google-handler");
const { addApprovedClient, bindStateToSession, createOAuthState, renderApprovalDialog } =
	await import("../src/workers-oauth-utils");

const realFetch = globalThis.fetch;

// What the runtime shim gives the handler to sign its forms and cookies with.
const COOKIE_SECRET = "cookie-secret";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** A KV namespace that keeps its values in a Map. */
function memoryKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
		list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
	};
}

/** Google answering the code exchange and the userinfo lookup. */
function serveGoogle(email: string, overrides: { verified?: boolean; scope?: string } = {}) {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("oauth2.googleapis.com/token")) {
			return new Response(
				JSON.stringify({
					access_token: "at",
					refresh_token: "rt",
					expires_in: 3600,
					scope:
						overrides.scope ??
						"https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/oauth2/v2/userinfo")) {
			return new Response(
				JSON.stringify(
					email
						? { email, verified_email: overrides.verified ?? true, name: "Tester" }
						: { name: "Tester" },
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("no route", { status: 404 });
	}) as unknown as typeof fetch;
}

const authRequest = {
	clientId: "client-1",
	redirectUri: CLAUDE_CALLBACK,
	scope: [],
	state: "s",
	responseType: "code",
	codeChallenge: "c",
	codeChallengeMethod: "S256",
};

/** A callback request carrying state that was properly issued and bound. */
async function callbackRequest(kv: ReturnType<typeof memoryKv>, clientId = authRequest.clientId) {
	const { stateToken } = await createOAuthState({ ...authRequest, clientId } as never, kv as never);
	const { setCookie } = await bindStateToSession(stateToken);
	const cookie = (setCookie.split(";")[0] ?? "").trim();
	return new Request(`https://server.example/callback?code=abc&state=${stateToken}`, {
		headers: { Cookie: cookie },
	});
}

function envFor(kv: ReturnType<typeof memoryKv>, allowed: string, completed: string[]) {
	return {
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		ALLOWED_EMAILS: allowed,
		MAX_ACCOUNTS: "25",
		OAUTH_KV: kv,
		OAUTH_PROVIDER: {
			completeAuthorization: async ({ props }: { props: { email: string } }) => {
				completed.push(props.email);
				return { redirectTo: `${CLAUDE_CALLBACK}?code=granted` };
			},
			listUserGrants: async () => ({ items: [] }),
			revokeGrant: async () => {},
		},
	};
}

beforeEach(() => {
	globalThis.fetch = realFetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("who the callback admits", () => {
	// isEmailAllowed has its own tests; this covers the place it is called, where
	// dropping the condition would let any Google account bind this deployment
	// while every other test stayed green.
	test("turns away an account outside the allowlist", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("stranger@example.com");
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "owner@example.com", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(completed).toEqual([]);
	});

	test("admits an account on the allowlist", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com");
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "owner@example.com", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(302);
		expect(completed).toEqual(["owner@example.com"]);
	});

	// An address Google has not confirmed belongs to the person signing in is
	// not evidence of anything, whatever the allowlist says.
	test("turns away an address Google has not verified", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com", { verified: false });
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(completed).toEqual([]);
	});
});

describe("pinning an account to its first client", () => {
	// Two clients in one environment, with ALLOWED_CLIENT_IDS left unset so the
	// automatic pin is in charge unless a test says otherwise.
	async function signIn(
		kv: ReturnType<typeof memoryKv>,
		clientId: string,
		completed: string[],
		settings: Record<string, string> = {},
	) {
		serveGoogle("Owner@Example.com");
		return GoogleHandler.fetch(
			await callbackRequest(kv, clientId),
			{ ...envFor(kv, "owner@example.com", completed), ...settings } as never,
			{} as never,
		);
	}

	test("records the client that completes the first sign-in", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		expect((await signIn(kv, "client-a", completed)).status).toBe(302);
		expect(await kv.get("pin:owner@example.com")).toBe("client-a");
		// The same client signing in again, as a reconnect does, is still welcome.
		expect((await signIn(kv, "client-a", completed)).status).toBe(302);
		expect(completed).toHaveLength(2);
	});

	test("refuses another client for that account, saying how to reset", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		await signIn(kv, "client-a", completed);
		const refused = await signIn(kv, "client-b", completed);
		expect(refused.status).toBe(403);
		const text = await refused.text();
		expect(text).toContain("client-b");
		expect(text).toContain('wrangler kv key delete "pin:owner@example.com"');
		expect(text).toContain("ALLOWED_CLIENT_IDS");
		// Google reported the address in mixed case; the pin matched it anyway.
		expect(completed).toEqual(["Owner@Example.com"]);
		expect(await kv.get("pin:owner@example.com")).toBe("client-a");
	});

	// claude.ai registers two clients for each Connect and finishes sign-in with
	// only one. Registration alone writes nothing here, so the client that never
	// finishes cannot take the pin from the one that does.
	test("pins the client that finished, not the first to register", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		// Both are registered and both start; only client-2 comes back from Google.
		await createOAuthState({ ...authRequest, clientId: "client-1" } as never, kv as never);
		expect((await signIn(kv, "client-2", completed)).status).toBe(302);
		expect(await kv.get("pin:owner@example.com")).toBe("client-2");
		expect((await signIn(kv, "client-1", completed)).status).toBe(403);
	});

	test("pins nothing when a sign-in fails before the grant exists", async () => {
		const kv = memoryKv();
		const env = {
			...envFor(kv, "owner@example.com", []),
			OAUTH_PROVIDER: {
				completeAuthorization: async () => {
					throw new Error("KV write failed");
				},
				listUserGrants: async () => ({ items: [] }),
				revokeGrant: async () => {},
			},
		};
		serveGoogle("owner@example.com");
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv, "client-a"),
			env as never,
			{} as never,
		);
		expect(response.status).toBe(500);
		expect(await kv.get("pin:owner@example.com")).toBeNull();
		expect((await signIn(kv, "client-b", [])).status).toBe(302);
	});

	test("lets a new client in once the pin is deleted, and pins that one", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		await signIn(kv, "client-a", completed);
		expect((await signIn(kv, "client-b", completed)).status).toBe(403);
		// What `wrangler kv key delete "pin:owner@example.com"` does.
		await kv.delete("pin:owner@example.com");
		expect((await signIn(kv, "client-b", completed)).status).toBe(302);
		expect(await kv.get("pin:owner@example.com")).toBe("client-b");
		expect((await signIn(kv, "client-a", completed)).status).toBe(403);
	});

	test("pins each account separately", async () => {
		const kv = memoryKv();
		await signIn(kv, "client-a", []);
		serveGoogle("second@example.com");
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv, "client-b"),
			envFor(kv, "*", []) as never,
			{} as never,
		);
		expect(response.status).toBe(302);
		expect(await kv.get("pin:second@example.com")).toBe("client-b");
	});

	// An explicit list is the operator deciding, and the automatic pin neither
	// refuses a client the list allows nor records anything beside it.
	test("gives way to ALLOWED_CLIENT_IDS", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		await signIn(kv, "client-a", completed);
		const response = await signIn(kv, "client-b", completed, {
			ALLOWED_CLIENT_IDS: "client-a,client-b",
		});
		expect(response.status).toBe(302);
		expect(await kv.get("pin:owner@example.com")).toBe("client-a");

		const fresh = memoryKv();
		await signIn(fresh, "client-a", [], { ALLOWED_CLIENT_IDS: "client-a" });
		expect(await fresh.get("pin:owner@example.com")).toBeNull();
	});

	test.each([["false"], ["0"], ["off"], [" False "]])(
		"is off when PIN_FIRST_CLIENT is %p",
		async (flag) => {
			const kv = memoryKv();
			const completed: string[] = [];
			await signIn(kv, "client-a", completed, { PIN_FIRST_CLIENT: flag });
			expect((await signIn(kv, "client-b", completed, { PIN_FIRST_CLIENT: flag })).status).toBe(
				302,
			);
			expect(await kv.get("pin:owner@example.com")).toBeNull();
		},
	);
});

describe("the cookies the approval sets", () => {
	// Three cookies are appended to one response. Collapsing them through a
	// plain object joins the values, and the session binding never lands — every
	// sign-in then fails at the callback with a green test suite.
	test("sends each of them as its own header", async () => {
		const kv = memoryKv();
		const env = {
			...envFor(kv, "*", []),
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => authRequest,
				lookupClient: async () => ({ clientId: "client-1", clientName: "Test Client" }),
			},
		};

		const dialog = await GoogleHandler.fetch(
			new Request("https://server.example/authorize?client_id=client-1"),
			env as never,
			{} as never,
		);
		const html = await dialog.text();
		const state = html.match(/name="state" value="([^"]+)"/)?.[1] ?? "";
		const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? "";
		expect(state).not.toBe("");
		const csrfCookie = (dialog.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

		const approved = await GoogleHandler.fetch(
			new Request("https://server.example/authorize", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: csrfCookie.trim(),
				},
				body: new URLSearchParams({ state, csrf_token: csrf }).toString(),
			}),
			env as never,
			{} as never,
		);

		const cookies = approved.headers.getSetCookie();
		expect(cookies).toHaveLength(3);
		expect(cookies.some((c) => c.startsWith("__Host-CONSENTED_STATE="))).toBe(true);
	});
});

describe("a consent that granted only some of what was asked", () => {
	// Google lets someone untick a permission and approve the rest. Without the
	// address there is nothing to key the allowlist, the account cap or the
	// session owner by, so the sign-in cannot finish — and it used to fail at
	// the userinfo lookup as a bare 500.
	test("says which permission was withheld instead of failing late", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("", {
			scope:
				"https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.profile",
		});
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toMatch(/email permission/);
		expect(completed).toEqual([]);
	});

	test("still refuses a consent without the Gmail permission", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com", {
			scope: "https://www.googleapis.com/auth/userinfo.email",
		});
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toMatch(/Gmail permission/);
	});

	// The state that brought the browser in was spent on arrival, so a bare
	// error page would strand the person: nothing on it could reopen Google's
	// screen, and the whole flow would have to be restarted from the client.
	test("offers a retry that reopens Google's consent screen directly", async () => {
		const kv = memoryKv();
		serveGoogle("owner@example.com", {
			scope: "https://www.googleapis.com/auth/userinfo.email",
		});
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", []) as never,
			{} as never,
		);
		const html = await response.text();
		const retry = html.match(/href="(https:\/\/accounts\.google\.com[^"]+)"/)?.[1] ?? "";
		expect(retry).toContain("state=");

		// The link only works if its state token exists and is bound to this
		// browser: a fresh state in KV and a fresh session cookie beside it.
		const state = new URL(retry.replace(/&amp;/g, "&")).searchParams.get("state") ?? "";
		expect(await kv.get(`oauth:state:${state}`)).not.toBeNull();
		const cookie = response.headers.get("Set-Cookie") ?? "";
		expect(cookie).toContain("__Host-CONSENTED_STATE=");
	});

	test("a retried consent that grants everything completes the sign-in", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com", {
			scope: "https://www.googleapis.com/auth/userinfo.email",
		});
		const refusal = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		const html = await refusal.text();
		const retry = (html.match(/href="(https:\/\/accounts\.google\.com[^"]+)"/)?.[1] ?? "").replace(
			/&amp;/g,
			"&",
		);
		const state = new URL(retry).searchParams.get("state") ?? "";
		const cookie = (refusal.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

		serveGoogle("owner@example.com");
		const second = await GoogleHandler.fetch(
			new Request(`https://server.example/callback?code=abc&state=${state}`, {
				headers: { Cookie: cookie },
			}),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(second.status).toBe(302);
		expect(completed).toEqual(["owner@example.com"]);
	});
});

describe("what /authorize will sign in", () => {
	// Parsing and the client lookup belong to the provider; what is under test
	// is what the handler does with a request the provider accepted.
	function authorizeEnv(
		kv: ReturnType<typeof memoryKv>,
		request: Record<string, unknown>,
		settings: Record<string, string> = {},
	) {
		return {
			...envFor(kv, "*", []),
			...settings,
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => request,
				lookupClient: async () => ({ clientId: request.clientId, clientName: "Test Client" }),
			},
		};
	}

	function authorize(cookie?: string) {
		return new Request(
			"https://server.example/authorize?client_id=client-1",
			cookie ? { headers: { Cookie: cookie } } : undefined,
		);
	}

	test("shows the dialog for Claude's own sign-in", async () => {
		const response = await GoogleHandler.fetch(
			authorize(),
			authorizeEnv(memoryKv(), authRequest) as never,
			{} as never,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('name="state"');
	});

	// The provider accepts any redirect the client registered for itself, and
	// registration is open, so a dialog shown here would send the owner's code
	// wherever the link's author chose.
	test.each([
		["another host", "https://client.example/cb"],
		["an app scheme", "microsoft-edge:https://evil.example/cb"],
		["a loopback callback", "http://localhost:33418/callback"],
	])("refuses a redirect to %s", async (_name, redirectUri) => {
		const kv = memoryKv();
		const response = await GoogleHandler.fetch(
			authorize(),
			authorizeEnv(kv, { ...authRequest, redirectUri }) as never,
			{} as never,
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("This server only signs in Claude.");
		expect(kv.store.size).toBe(0);
	});

	// A remembered client skips the dialog and has a state stored at once, so
	// the check has to stand ahead of that as well.
	test("refuses it for a client approved before, storing nothing", async () => {
		const kv = memoryKv();
		const approved = await addApprovedClient(
			new Request("https://server.example/authorize"),
			"client-1",
			COOKIE_SECRET,
		);
		const cookie = approved.split(";")[0] ?? "";

		const refused = await GoogleHandler.fetch(
			authorize(cookie),
			authorizeEnv(kv, { ...authRequest, redirectUri: "https://client.example/cb" }) as never,
			{} as never,
		);
		expect(refused.status).toBe(400);
		expect(kv.store.size).toBe(0);

		const remembered = await GoogleHandler.fetch(
			authorize(cookie),
			authorizeEnv(kv, authRequest) as never,
			{} as never,
		);
		expect(remembered.status).toBe(302);
		expect(remembered.headers.get("Location") ?? "").toStartWith("https://accounts.google.com/");
		expect(kv.store.size).toBe(1);
	});

	// The provider lets a request without a challenge through, and compares a
	// method it does not know as plain.
	test.each([
		["no challenge", { codeChallenge: undefined }],
		["a method it does not know", { codeChallengeMethod: "xyz" }],
		["the plain method", { codeChallengeMethod: "plain" }],
	])("refuses a request with %s", async (_name, change) => {
		const kv = memoryKv();
		const response = await GoogleHandler.fetch(
			authorize(),
			authorizeEnv(kv, { ...authRequest, ...change }) as never,
			{} as never,
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("This server requires PKCE with S256.");
		expect(kv.store.size).toBe(0);
	});

	// The operator's list replaces Claude's callbacks rather than adding to them,
	// and is held to the same exact comparison.
	test("signs in a redirect named in ALLOWED_REDIRECT_URIS", async () => {
		const redirectUri = "https://app.example/oauth/callback";
		const response = await GoogleHandler.fetch(
			authorize(),
			authorizeEnv(
				memoryKv(),
				{ ...authRequest, redirectUri },
				{ ALLOWED_REDIRECT_URIS: `${CLAUDE_CALLBACK}, ${redirectUri}` },
			) as never,
			{} as never,
		);
		expect(response.status).toBe(200);
	});

	test.each([
		["Claude's callback once the list leaves it out", CLAUDE_CALLBACK],
		["a near miss of a listed URI", "https://app.example/oauth/callback/"],
		["a loopback callback", "http://localhost:33418/callback"],
	])("refuses %s when ALLOWED_REDIRECT_URIS is set", async (_name, redirectUri) => {
		const kv = memoryKv();
		const response = await GoogleHandler.fetch(
			authorize(),
			authorizeEnv(
				kv,
				{ ...authRequest, redirectUri },
				{ ALLOWED_REDIRECT_URIS: "https://app.example/oauth/callback" },
			) as never,
			{} as never,
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("ALLOWED_REDIRECT_URIS");
		expect(kv.store.size).toBe(0);
	});

	test("refuses a client outside ALLOWED_CLIENT_IDS, saying how to add one", async () => {
		const kv = memoryKv();
		const response = await GoogleHandler.fetch(
			authorize(),
			authorizeEnv(kv, authRequest, { ALLOWED_CLIENT_IDS: "client-0, client-2" }) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		const text = await response.text();
		expect(text).toContain("pinned");
		expect(text).toContain("client client-1 is not one of them");
		expect(text).toContain("wrangler secret put ALLOWED_CLIENT_IDS");
		expect(kv.store.size).toBe(0);
	});

	test.each([
		["names it", "client-0, client-1"],
		["is empty", ""],
		["holds only separators", " , "],
	])("lets a client through when ALLOWED_CLIENT_IDS %s", async (_name, ids) => {
		const response = await GoogleHandler.fetch(
			authorize(),
			authorizeEnv(memoryKv(), authRequest, { ALLOWED_CLIENT_IDS: ids }) as never,
			{} as never,
		);
		expect(response.status).toBe(200);
	});
});

describe("what an approval will sign in", () => {
	// The form the dialog would have rendered for this request, signed the same
	// way, posted with the CSRF cookie and token that go with it.
	async function approval(oauthReqInfo: Record<string, unknown>, issuedAt?: number) {
		const state: Record<string, unknown> = { oauthReqInfo };
		if (issuedAt !== undefined) state.issuedAt = issuedAt;
		const dialog = await renderApprovalDialog(new Request("https://server.example/authorize"), {
			client: null,
			csrfToken: "csrf-token",
			server: { name: "Gmail MCP" },
			setCookie: "",
			cookieSecret: COOKIE_SECRET,
			state,
		});
		const signed = (await dialog.text()).match(/name="state" value="([^"]+)"/)?.[1] ?? "";
		return new Request("https://server.example/authorize", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Cookie: "__Host-CSRF_TOKEN=csrf-token",
			},
			body: new URLSearchParams({ state: signed, csrf_token: "csrf-token" }).toString(),
		});
	}

	function approve(
		request: Request,
		kv: ReturnType<typeof memoryKv>,
		settings: Record<string, string> = {},
	) {
		return GoogleHandler.fetch(
			request,
			{ ...envFor(kv, "*", []), ...settings } as never,
			{} as never,
		);
	}

	test("sends a fresh approval for Claude on to Google", async () => {
		const kv = memoryKv();
		const response = await approve(await approval(authRequest, Date.now()), kv);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location") ?? "").toStartWith("https://accounts.google.com/");
		expect(kv.store.size).toBe(1);
	});

	// A signed form carries no expiry of its own beyond the one checked below,
	// so one signed before these checks existed is held to them here.
	test("refuses a signed form whose request goes anywhere but Claude", async () => {
		const kv = memoryKv();
		const response = await approve(
			await approval({ ...authRequest, redirectUri: "https://client.example/cb" }, Date.now()),
			kv,
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("This server only signs in Claude.");
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(kv.store.size).toBe(0);
	});

	test("refuses a signed form without PKCE", async () => {
		const kv = memoryKv();
		const response = await approve(
			await approval({ ...authRequest, codeChallenge: undefined }, Date.now()),
			kv,
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("This server requires PKCE with S256.");
		expect(kv.store.size).toBe(0);
	});

	// A form signed while a redirect was allowed is refused once the operator
	// narrows ALLOWED_REDIRECT_URIS.
	test("refuses a signed form whose redirect ALLOWED_REDIRECT_URIS no longer lists", async () => {
		const kv = memoryKv();
		const response = await approve(await approval(authRequest, Date.now()), kv, {
			ALLOWED_REDIRECT_URIS: "https://app.example/oauth/callback",
		});
		expect(response.status).toBe(400);
		expect(kv.store.size).toBe(0);
	});

	// A form signed before the pin was set names a client the pin now refuses.
	test("refuses a signed form for a client outside ALLOWED_CLIENT_IDS", async () => {
		const kv = memoryKv();
		const response = await approve(await approval(authRequest, Date.now()), kv, {
			ALLOWED_CLIENT_IDS: "client-0",
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("wrangler secret put ALLOWED_CLIENT_IDS");
		expect(kv.store.size).toBe(0);
	});

	// Without an age, one form fetched once could be posted back for a fresh
	// state and a KV write as often as anyone liked.
	test.each([
		["signed more than ten minutes ago", Date.now() - 11 * 60 * 1000],
		["signed before forms carried a time", undefined],
	])("refuses a form %s", async (_name, issuedAt) => {
		const kv = memoryKv();
		const response = await approve(await approval(authRequest, issuedAt), kv);
		expect(response.status).toBe(400);
		expect(await response.text()).toMatch(/expired/);
		expect(kv.store.size).toBe(0);
	});

	test("still accepts a form signed nine minutes ago", async () => {
		const kv = memoryKv();
		const response = await approve(await approval(authRequest, Date.now() - 9 * 60 * 1000), kv);
		expect(response.status).toBe(302);
	});
});

describe("how often the sign-in steps answer", () => {
	// A limiter that answers as told, and a provider that notes when it is
	// first asked anything, both recording into one list in order.
	function limitedEnv(kv: ReturnType<typeof memoryKv>, events: string[], allow: boolean) {
		return {
			...envFor(kv, "*", []),
			REGISTER_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					events.push(`limit ${key}`);
					return { success: allow };
				},
			},
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => {
					events.push("parse");
					return authRequest;
				},
				lookupClient: async () => ({ clientId: "client-1", clientName: "Test Client" }),
			},
		};
	}

	test("turns a caller away from every step before anything is read or stored", async () => {
		const kv = memoryKv();
		const events: string[] = [];
		let google = 0;
		globalThis.fetch = (async () => {
			google += 1;
			return new Response("{}");
		}) as unknown as typeof fetch;
		const caller = { "CF-Connecting-IP": "203.0.113.9" };
		const steps = [
			new Request("https://server.example/authorize?client_id=client-1", { headers: caller }),
			new Request("https://server.example/authorize", {
				method: "POST",
				headers: { ...caller, "Content-Type": "application/x-www-form-urlencoded" },
				body: "state=s&csrf_token=t",
			}),
			new Request("https://server.example/callback?code=abc&state=s", { headers: caller }),
		];
		for (const step of steps) {
			const response = await GoogleHandler.fetch(
				step,
				limitedEnv(kv, events, false) as never,
				{} as never,
			);
			expect(response.status).toBe(429);
		}
		expect(events).toEqual(["limit 203.0.113.9", "limit 203.0.113.9", "limit 203.0.113.9"]);
		expect(kv.store.size).toBe(0);
		expect(google).toBe(0);
	});

	test("lets a caller under the limit through", async () => {
		const events: string[] = [];
		const response = await GoogleHandler.fetch(
			new Request("https://server.example/authorize?client_id=client-1", {
				headers: { "CF-Connecting-IP": "203.0.113.9" },
			}),
			limitedEnv(memoryKv(), events, true) as never,
			{} as never,
		);
		expect(response.status).toBe(200);
		expect(events).toEqual(["limit 203.0.113.9", "parse"]);
	});

	// One subscriber's /64 is one caller, whichever of its addresses it uses.
	test("counts every address in an IPv6 /64 as one caller", async () => {
		const events: string[] = [];
		for (const address of ["2001:db8:1:2::a", "2001:db8:1:2:ffff:ffff:ffff:ffff"]) {
			await GoogleHandler.fetch(
				new Request("https://server.example/callback?code=abc&state=s", {
					headers: { "CF-Connecting-IP": address },
				}),
				limitedEnv(memoryKv(), events, false) as never,
				{} as never,
			);
		}
		expect(events).toEqual(["limit 2001:db8:1:2::/64", "limit 2001:db8:1:2::/64"]);
	});
});

describe("the grants a sign-in leaves behind", () => {
	type Summary = { id: string; clientId: string };

	// A provider whose grant listing comes back a page at a time, recording
	// what the handler asks of it in order.
	function grantsEnv(
		kv: ReturnType<typeof memoryKv>,
		pages: Summary[][],
		events: string[],
		provider: Record<string, unknown> = {},
	) {
		return {
			...envFor(kv, "*", []),
			OAUTH_PROVIDER: {
				completeAuthorization: async () => {
					events.push("complete");
					return { redirectTo: `${CLAUDE_CALLBACK}?code=granted` };
				},
				listUserGrants: async (userId: string, options?: { cursor?: string }) => {
					const page = Number(options?.cursor ?? 0);
					events.push(`list ${userId} page ${page}`);
					const next = page + 1 < pages.length ? { cursor: String(page + 1) } : {};
					return { items: pages[page] ?? [], ...next };
				},
				revokeGrant: async (grantId: string, userId: string) => {
					events.push(`revoke ${grantId} ${userId}`);
				},
				...provider,
			},
		};
	}

	// Claude registers a new client on every fresh connection, and the provider
	// retires only the earlier grants of the client signing in.
	test("retires the account's grants held by any other client, across pages", async () => {
		const kv = memoryKv();
		const events: string[] = [];
		serveGoogle("owner@example.com");
		const pages = [
			[
				{ id: "g-removed", clientId: "client-0" },
				{ id: "g-current", clientId: "client-1" },
			],
			[{ id: "g-phished", clientId: "client-x" }],
		];
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			grantsEnv(kv, pages, events) as never,
			{} as never,
		);
		expect(response.status).toBe(302);
		expect(events).toEqual([
			"complete",
			"list owner@example.com page 0",
			"list owner@example.com page 1",
			"revoke g-removed owner@example.com",
			"revoke g-phished owner@example.com",
		]);
	});

	test("still completes the sign-in when the earlier grants cannot be listed", async () => {
		const kv = memoryKv();
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			serveGoogle("owner@example.com");
			const response = await GoogleHandler.fetch(
				await callbackRequest(kv),
				grantsEnv(kv, [], [], {
					listUserGrants: async () => {
						throw new Error("Too many subrequests");
					},
				}) as never,
				{} as never,
			);
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(`${CLAUDE_CALLBACK}?code=granted`);
			expect(await kv.get("account:owner@example.com")).not.toBeNull();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("a grant that will not revoke stops neither the others nor the sign-in", async () => {
		const kv = memoryKv();
		const events: string[] = [];
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			serveGoogle("owner@example.com");
			const pages = [
				[
					{ id: "g-stuck", clientId: "client-0" },
					{ id: "g-stray", clientId: "client-x" },
				],
			];
			const response = await GoogleHandler.fetch(
				await callbackRequest(kv),
				grantsEnv(kv, pages, events, {
					revokeGrant: async (grantId: string) => {
						events.push(`revoke ${grantId}`);
						if (grantId === "g-stuck") throw new Error("KV unavailable");
					},
				}) as never,
				{} as never,
			);
			expect(response.status).toBe(302);
			expect(events).toContain("revoke g-stuck");
			expect(events).toContain("revoke g-stray");
			expect(warn).toHaveBeenCalledWith("could not retire 1 of 2 earlier grants");
		} finally {
			warn.mockRestore();
		}
	});

	test("a sign-in that is turned away retires nothing", async () => {
		const kv = memoryKv();
		const events: string[] = [];
		serveGoogle("stranger@example.com");
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			{
				...grantsEnv(kv, [[{ id: "g-current", clientId: "client-0" }]], events),
				ALLOWED_EMAILS: "owner@example.com",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(events).toEqual([]);
	});
});
