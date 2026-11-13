import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import "./runtime-shim";
import { signData } from "../src/workers-oauth-utils";

const { GmailMCP, default: worker } = await import("../src/index");

// Signs the file addresses a session hands out, and is what the Worker checks
// them against.
const COOKIE_KEY = "cookie-secret";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
type Route = (url: string, init: RequestInit) => unknown;

const realFetch = globalThis.fetch;

function parseBody(body: BodyInit | null | undefined): unknown {
	if (!body) return undefined;
	const text = String(body);
	try {
		return JSON.parse(text);
	} catch {
		return Object.fromEntries(new URLSearchParams(text));
	}
}

/** Every Gmail request the agent made during a test. */
let requests: { url: string; method: string; body: unknown }[] = [];

/** Stands Gmail up from a table of path matchers. */
function serveGmail(routes: [RegExp, Route][]) {
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		requests.push({
			url,
			method: init.method ?? "GET",
			// A token refresh posts a form; everything else posts JSON.
			body: parseBody(init.body),
		});
		for (const [pattern, route] of routes) {
			if (pattern.test(url)) {
				const value = route(url, init);
				if (value instanceof Response) return value;
				return new Response(JSON.stringify(value), { status: 200 });
			}
		}
		return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
	}) as unknown as typeof fetch;
}

function makeAgent(email = "me@example.com") {
	const handlers = new Map<string, Handler>();
	// What each tool declared beside its schema, when it declared anything.
	const annotations = new Map<string, Record<string, unknown> | undefined>();
	const storage = new Map<string, unknown>();
	const agent = Object.create(GmailMCP.prototype) as Record<string, unknown>;
	agent.server = {
		// The handler always comes last; annotations sit between it and the
		// schema when a tool passes them.
		tool: (name: string, ...rest: unknown[]) => {
			handlers.set(name, rest[rest.length - 1] as Handler);
			annotations.set(name, rest.length === 4 ? (rest[2] as Record<string, unknown>) : undefined);
		},
	};
	agent.props = {
		email,
		name: "Tester",
		accessToken: "access-token",
		refreshToken: "refresh-token",
		expiresAt: Date.now() + 3_600_000,
	};
	agent.ctx = {
		id: { name: "streamable-http:session-1" },
		storage: {
			get: async (key: string) => storage.get(key),
			put: async (key: string, value: unknown) => {
				storage.set(key, value);
			},
			list: async (options?: { prefix?: string }) =>
				new Map([...storage].filter(([key]) => key.startsWith(options?.prefix ?? ""))),
			delete: async (keys: string | string[]) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
			},
		},
	};
	agent.env = {
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		COOKIE_ENCRYPTION_KEY: COOKIE_KEY,
	};
	return { agent, handlers, annotations, storage };
}

async function boot(email?: string) {
	const made = makeAgent(email);
	await (made.agent as { init: () => Promise<void> }).init();
	return made;
}

/**
 * What the public file routes run against: a session namespace that records
 * every name an object is started under and hands whatever reaches one to
 * serve, and a limiter that records every caller it counts.
 */
function fileRouteEnv(
	serve: (request: Request) => Promise<Response> = async () => new Response("reached"),
) {
	const woken: string[] = [];
	const limited: string[] = [];
	const env = {
		COOKIE_ENCRYPTION_KEY: COOKIE_KEY,
		MCP_OBJECT: {
			idFromName: (name: string) => ({ name }),
			get: () => ({
				setName: async (name: string) => {
					woken.push(name);
				},
				fetch: serve,
			}),
		},
		REGISTER_LIMITER: {
			limit: async ({ key }: { key: string }) => {
				limited.push(key);
				return { success: true };
			},
		},
	};
	return { env: env as never, woken, limited };
}

/** A handler that must exist, so a missing one fails loudly rather than quietly. */
function tool(handlers: Map<string, Handler>, name: string): Handler {
	const handler = handlers.get(name);
	if (!handler) throw new Error(`no handler registered for ${name}`);
	return handler;
}

/** The JSON a tool answered with. */
function result(reply: { content: { text: string }[] }): Record<string, unknown> {
	return JSON.parse(reply.content[0]?.text ?? "{}");
}

const b64url = (s: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(s)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const message = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	threadId: `t-${id}`,
	labelIds: ["INBOX"],
	snippet: `snippet ${id}`,
	payload: {
		mimeType: "text/plain",
		headers: [
			{ name: "From", value: "Alice <alice@example.com>" },
			{ name: "To", value: "me@example.com, bob@example.com" },
			{ name: "Cc", value: "carol@example.com" },
			{ name: "Subject", value: "Quarterly report" },
			{ name: "Date", value: "Mon, 27 Jul 2026 10:00:00 +0000" },
			{ name: "Message-ID", value: "<orig@mail.example.com>" },
		],
		body: { data: b64url("the original body") },
	},
	...overrides,
});

beforeEach(() => {
	requests = [];
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("session ownership", () => {
	test("the first account to call claims the session", async () => {
		const { handlers, storage } = await boot("first@example.com");
		serveGmail([[/\/profile/, () => ({ emailAddress: "first@example.com" })]]);
		await tool(handlers, "whoami")({});
		expect(storage.get("owner")).toBe("first@example.com");
	});

	test("a second account cannot use a claimed session", async () => {
		const { agent, handlers, storage } = await boot("owner@example.com");
		serveGmail([[/\/profile/, () => ({ emailAddress: "owner@example.com" })]]);
		await tool(handlers, "whoami")({});

		// The same object, now reached carrying another account's grant.
		(agent as { props: { email: string } }).props.email = "intruder@example.com";
		await expect(tool(handlers, "whoami")({})).rejects.toThrow(/different Google account/);
		expect(storage.get("owner")).toBe("owner@example.com");
	});

	// An object started by a foreign grant holds that account's credentials for
	// as long as it lives, while storage still names the owner. The owner's own
	// calls then pass the caller check and would reach the wrong mailbox, so
	// what they send has to be settled against the owner too.
	test("refuses credentials that no longer belong to the owner", async () => {
		const { agent, handlers } = await boot("owner@example.com");
		serveGmail([[/\/profile/, () => ({ emailAddress: "owner@example.com" })]]);
		await tool(handlers, "whoami")({});

		// The caller is still the owner — the account the boundary stamped on the
		// request — and only the grant underneath it changed.
		(agent as { callerAccount: string }).callerAccount = "owner@example.com";
		const props = (agent as { props: Record<string, string | number> }).props;
		props.email = "intruder@example.com";
		props.accessToken = "intruder-access-token";
		await expect(tool(handlers, "whoami")({})).rejects.toThrow(/different Google account/);
		expect(requests).toHaveLength(1);
	});
});

describe("a session started by the wrong grant", () => {
	// Starting the object is what binds its credentials, so a grant that does
	// not own the session must not be the one to do it: otherwise the owner's
	// own calls fail for as long as the object lives.
	test("refuses to start, and starts for the owner afterwards", async () => {
		const made = makeAgent("intruder@example.com");
		made.storage.set("owner", "owner@example.com");
		await expect((made.agent as { init: () => Promise<void> }).init()).rejects.toThrow(
			/different Google account/,
		);

		const props = (made.agent as { props: Record<string, string | number> }).props;
		props.email = "owner@example.com";
		await (made.agent as { init: () => Promise<void> }).init();
		serveGmail([[/\/profile/, () => ({ emailAddress: "owner@example.com" })]]);
		const out = result(await tool(made.handlers, "whoami")({}));
		expect(out.emailAddress).toBe("owner@example.com");
	});
});

describe("search_messages", () => {
	test("reports a message that vanished without losing the rest", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\?/, () => ({ messages: [{ id: "m1" }, { id: "gone" }], resultSizeEstimate: 2 })],
			[
				/\/messages\/gone/,
				() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
			],
			[/\/messages\/m1/, () => message("m1")],
		]);
		const out = result(await tool(handlers, "search_messages")({ query: "x", maxResults: 10 }));
		const messages = out.messages as Record<string, unknown>[];
		expect(messages).toHaveLength(2);
		expect(messages[0]?.subject).toBe("Quarterly report");
		expect(messages[1]).toHaveProperty("error");
	});

	test("asks Gmail for the Cc header", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\?/, () => ({ messages: [{ id: "m1" }] })],
			[/\/messages\/m1/, () => message("m1")],
		]);
		await tool(handlers, "search_messages")({ query: "x", maxResults: 1 });
		expect(requests.some((r) => r.url.includes("metadataHeaders=Cc"))).toBe(true);
	});

	// A reply follows Reply-To, so a search that leaves it out shows the sender
	// while hiding where an answer to them would go.
	test("asks Gmail for Reply-To and Bcc, and reports them", async () => {
		const { handlers } = await boot();
		const routed = message("m1");
		routed.payload.headers.push({ name: "Reply-To", value: "billing@evil.example" });
		serveGmail([
			[/\/messages\?/, () => ({ messages: [{ id: "m1" }] })],
			[/\/messages\/m1/, () => routed],
		]);
		const out = result(await tool(handlers, "search_messages")({ query: "x", maxResults: 1 }));
		const fetched = requests.find((r) => r.url.includes("/messages/m1"))?.url ?? "";
		expect(fetched).toContain("metadataHeaders=Reply-To");
		expect(fetched).toContain("metadataHeaders=Bcc");
		expect((out.messages as Record<string, unknown>[])[0]?.replyTo).toBe("billing@evil.example");
	});
});

describe("send_message", () => {
	test("refuses a thread id with no message to reply to", async () => {
		const { handlers } = await boot();
		serveGmail([]);
		await expect(
			tool(
				handlers,
				"send_message",
			)({
				to: "a@example.com",
				subject: "s",
				body: "b",
				threadId: "t-1",
			}),
		).rejects.toThrow(/inReplyTo/);
	});

	test("resolves a Gmail id into the Message-ID it threads on", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=metadata/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		await tool(
			handlers,
			"send_message",
		)({
			to: "a@example.com",
			subject: "s",
			body: "b",
			inReplyTo: "m1",
		});
		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const raw = new TextDecoder().decode(
			Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
		);
		expect(raw).toContain("In-Reply-To: <orig@mail.example.com>");
	});
});

describe("reply_all", () => {
	const everyone = ["alice@example.com", "bob@example.com", "carol@example.com"];
	const sends = () => requests.filter((r) => r.url.includes("/messages/send"));

	test("answers the sender, keeps the others, drops this account", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const out = result(
			await tool(handlers, "reply_all")({ messageId: "m1", recipients: everyone, body: "ok" }),
		);
		expect(out.to).toEqual(["alice@example.com"]);
		expect(out.cc).toEqual(["bob@example.com", "carol@example.com"]);
	});

	// The approval a send can wait on shows its arguments, and who a reply
	// reaches is worked out here. Asking for the list puts it in front of the
	// person approving; one that leaves someone out names them all and sends
	// nothing.
	test("refuses a list that differs, naming everyone the reply would reach", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const reply = tool(handlers, "reply_all");
		await expect(
			reply({ messageId: "m1", recipients: ["alice@example.com"], body: "ok" }),
		).rejects.toThrow("this would reach alice@example.com, bob@example.com, carol@example.com");
		await expect(
			reply({ messageId: "m1", recipients: [...everyone, "extra@example.com"], body: "ok" }),
		).rejects.toThrow(/nothing was sent/);
		expect(sends()).toHaveLength(0);
	});

	test("compares mailboxes, not the way they are spelled", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		await tool(
			handlers,
			"reply_all",
		)({
			messageId: "m1",
			recipients: ["carol@example.com", "Alice@Example.COM", "bob+reports@example.com"],
			body: "ok",
		});
		expect(sends()).toHaveLength(1);
	});

	// Business email compromise: the name and From are the client's, and the
	// Reply-To is the attacker's. Following Reply-To is right, but nothing
	// showed it before the mail went; now it has to be named to be sent.
	test("follows Reply-To, and will not send until that address is named", async () => {
		const { handlers } = await boot();
		const redirected = message("m1");
		redirected.payload.headers = [
			{ name: "From", value: "Pat Client <pat@client.example>" },
			{ name: "Reply-To", value: "pat.client.billing@evil.example" },
			{ name: "To", value: "me@example.com" },
			{ name: "Subject", value: "Signed agreement" },
		];
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => redirected],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const read = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		expect(read.replyTo).toBe("pat.client.billing@evil.example");

		await expect(
			tool(
				handlers,
				"reply_all",
			)({
				messageId: "m1",
				recipients: ["pat@client.example"],
				body: "Attached.",
			}),
		).rejects.toThrow("this would reach pat.client.billing@evil.example.");
		expect(sends()).toHaveLength(0);

		await tool(
			handlers,
			"reply_all",
		)({ messageId: "m1", recipients: ["pat.client.billing@evil.example"], body: "Attached." });
		expect(sentMime("/messages/send")).toContain("To: pat.client.billing@evil.example");
	});

	// A tag folds away to compare mailboxes, so one entry could carry the
	// client's whole address before the attacker's domain and still match,
	// with the approval showing the client's address inside it.
	test("refuses a stated recipient that is more than one bare address", async () => {
		const { handlers } = await boot();
		const redirected = message("m1");
		redirected.payload.headers = [
			{ name: "From", value: "Pat Client <pat.client@client.example>" },
			{ name: "Reply-To", value: "pat.client.billing@gmail.com" },
			{ name: "To", value: "me@example.com" },
			{ name: "Subject", value: "Signed agreement" },
		];
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => redirected],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		for (const recipient of [
			"patclientbilling+pat.client@client.example@gmail.com",
			"Pat <pat.client.billing@gmail.com>",
			"pat.client.billing@gmail.com, pat.client@client.example",
		]) {
			await expect(
				tool(
					handlers,
					"reply_all",
				)({ messageId: "m1", recipients: [recipient], body: "Attached." }),
			).rejects.toThrow(/one bare address per entry/);
		}
		expect(sends()).toHaveLength(0);
	});

	// A display name is text the sender chose, and the reply goes to the
	// address after it, as a mail server would deliver it.
	test("answers the address, not one written inside a display name", async () => {
		const { handlers } = await boot();
		const named = message("m1");
		named.payload.headers = [
			{ name: "From", value: '"Pat Client <spy@evil.example>" <pat@client.example>' },
			{ name: "To", value: "me@example.com" },
			{ name: "Cc", value: "boss@client.example (<spy@evil.example>)" },
			{ name: "Subject", value: "Signed agreement" },
		];
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => named],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const out = result(
			await tool(
				handlers,
				"reply_all",
			)({
				messageId: "m1",
				recipients: ["pat@client.example", "boss@client.example"],
				body: "ok",
			}),
		);
		expect(out.to).toEqual(["pat@client.example"]);
		expect(out.cc).toEqual(["boss@client.example"]);
		const headers = sentMime("/messages/send").split("\r\n\r\n")[0] ?? "";
		expect(headers).toContain("To: pat@client.example");
		expect(headers).toContain("Cc: boss@client.example");
		expect(headers).not.toContain("spy@evil.example");
	});

	// Every threading value on the original is written by whoever sent it, and
	// one too wide for a header line used to reach the builder and throw, so a
	// crafted message could not be answered at all.
	test("answers a message whose threading headers cannot be sent back", async () => {
		const { handlers } = await boot();
		const hostile = message("m1");
		hostile.payload.headers = [
			{ name: "From", value: `${"x".repeat(950)}@evil.example.com` },
			{ name: "To", value: "me@example.com, bob@example.com" },
			{ name: "Subject", value: "Quarterly report" },
			{ name: "Message-ID", value: `<${"z".repeat(950)}@evil.example.com>` },
			{ name: "References", value: `<${"w".repeat(950)}@evil.example.com> <real@example.com>` },
		];
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => hostile],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const out = result(
			await tool(
				handlers,
				"reply_all",
			)({ messageId: "m1", recipients: ["bob@example.com"], body: "ok" }),
		);
		expect(out.to).toEqual(["bob@example.com"]);

		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const mime = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
		expect(mime).toContain("References: <real@example.com>");
		expect(mime).not.toContain("In-Reply-To:");
		expect(mime).not.toContain("evil.example.com");
	});
});

describe("reply_all from a send-as alias", () => {
	// Mail written to an alias is mail to this account. Treating the alias as a
	// stranger copies it back to the person replying, and answering from the
	// primary address hands the correspondent an address they never had.
	const toAlias = message("m1");
	toAlias.payload.headers = [
		{ name: "From", value: "Alice <alice@example.com>" },
		{ name: "To", value: "sales@example.com" },
		{ name: "Cc", value: "bob@example.com" },
		{ name: "Subject", value: "Order" },
	];

	const serve = () =>
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "sales@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => toAlias],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);

	const recipients = ["alice@example.com", "bob@example.com"];

	test("keeps the alias out of the reply and answers from it", async () => {
		const { handlers } = await boot();
		serve();
		const out = result(
			await tool(handlers, "reply_all")({ messageId: "m1", recipients, body: "ok" }),
		);
		expect(out.to).toEqual(["alice@example.com"]);
		expect(out.cc).toEqual(["bob@example.com"]);

		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const mime = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
		expect(mime).toContain("From: sales@example.com");
	});

	test("reads the identities once and remembers them", async () => {
		const { handlers } = await boot();
		serve();
		await tool(handlers, "reply_all")({ messageId: "m1", recipients, body: "one" });
		await tool(handlers, "reply_all")({ messageId: "m1", recipients, body: "two" });
		expect(requests.filter((r) => r.url.includes("/settings/sendAs"))).toHaveLength(1);
	});
});

/** The MIME a call handed to Gmail, decoded from its base64url raw. */
function sentMime(urlPart: string, method?: string): string {
	const sent = requests.find((r) => r.url.includes(urlPart) && (!method || r.method === method));
	const body = sent?.body as { raw?: string; message?: { raw?: string } } | undefined;
	const encoded = String(body?.raw ?? body?.message?.raw ?? "");
	return new TextDecoder().decode(
		Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
	);
}

/** The readable text inside a MIME body, decoded from its base64 lines. */
function mimeText(mime: string): string {
	const body = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n");
	return new TextDecoder().decode(
		Uint8Array.from(atob(body.replace(/[^A-Za-z0-9+/=]/g, "")), (c) => c.charCodeAt(0)),
	);
}

describe("create_draft as a reply", () => {
	const serve = () =>
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/drafts$/, () => ({ id: "d1", message: { id: "dm1", threadId: "t-m1" } })],
		]);

	test("joins the thread with the headers other clients need", async () => {
		const { handlers } = await boot();
		serve();
		const out = result(
			await tool(handlers, "create_draft")({ body: "my answer", replyToMessageId: "m1" }),
		);
		expect(out.draftId).toBe("d1");
		expect(out.threadId).toBe("t-m1");
		// The whole envelope, since sending the draft later reaches all of it.
		expect(out.to).toBe("alice@example.com");
		expect(out.cc).toBe("bob@example.com, carol@example.com");

		const created = requests.find((r) => r.url.endsWith("/drafts"));
		const posted = (created?.body ?? {}) as { message?: { threadId?: string } };
		expect(posted.message?.threadId).toBe("t-m1");
		const mime = sentMime("/drafts");
		expect(mime).toContain("In-Reply-To: <orig@mail.example.com>");
		expect(mime).toContain("References: <orig@mail.example.com>");
		expect(mime).toContain("Subject: Re: Quarterly report");
		expect(mime).toContain("To: alice@example.com");
		expect(mime).toContain("Cc: bob@example.com, carol@example.com");
	});

	test("quotes the original under the body", async () => {
		const { handlers } = await boot();
		serve();
		await tool(
			handlers,
			"create_draft",
		)({ body: "my answer", replyToMessageId: "m1", quote: true });
		const text = mimeText(sentMime("/drafts"));
		expect(text).toContain("my answer");
		expect(text).toContain("> the original body");
		expect(text).toContain("wrote:");
	});

	test("leaves the original out when asked not to quote", async () => {
		const { handlers } = await boot();
		serve();
		await tool(
			handlers,
			"create_draft",
		)({ body: "my answer", replyToMessageId: "m1", quote: false });
		const text = mimeText(sentMime("/drafts"));
		expect(text).toContain("my answer");
		expect(text).not.toContain("> the original body");
	});

	// A caller that names its own recipients owns all of them; deriving a Cc
	// beside a written To would copy people the caller chose to leave out.
	test("a written To replaces the derived recipients whole", async () => {
		const { handlers } = await boot();
		serve();
		await tool(
			handlers,
			"create_draft",
		)({ body: "b", replyToMessageId: "m1", to: "only@example.com" });
		const mime = sentMime("/drafts");
		expect(mime).toContain("To: only@example.com");
		expect(mime).not.toContain("Cc:");
	});

	// "Draft a reply and cc my partner" passes a Cc and no To. Replacing that Cc
	// with the original's audience dropped the partner and copied a public list
	// on what was meant to stay internal.
	test("keeps a Cc the caller wrote when the To is derived", async () => {
		const { handlers } = await boot();
		const toList = message("m1");
		toList.payload.headers = [
			{ name: "From", value: "Alice <alice@client.example>" },
			{ name: "To", value: "me@example.com, vendor-list@public.example" },
			{ name: "Subject", value: "Pricing" },
		];
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => toList],
			[/\/drafts$/, () => ({ id: "d1", message: { id: "dm1", threadId: "t-m1" } })],
		]);
		const out = result(
			await tool(
				handlers,
				"create_draft",
			)({ replyToMessageId: "m1", cc: "boss@me-company.example", body: "internal pricing" }),
		);
		const mime = sentMime("/drafts");
		expect(mime).toContain("To: alice@client.example");
		expect(mime).toContain("Cc: boss@me-company.example");
		expect(mime).not.toContain("vendor-list@public.example");
		expect(out).toMatchObject({ to: "alice@client.example", cc: "boss@me-company.example" });
	});

	test("a fresh draft still needs its recipients spelled out", async () => {
		const { handlers } = await boot();
		serveGmail([]);
		await expect(tool(handlers, "create_draft")({ body: "b" })).rejects.toThrow(/replyToMessageId/);
	});

	test("a fresh draft reports everyone it will reach", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/drafts$/, () => ({ id: "d1", message: { id: "dm1" } })]]);
		const out = result(
			await tool(
				handlers,
				"create_draft",
			)({
				to: "a@example.com",
				cc: "c@example.com",
				bcc: "hidden@example.com",
				subject: "s",
				body: "b",
			}),
		);
		expect(out).toMatchObject({
			draftId: "d1",
			to: "a@example.com",
			cc: "c@example.com",
			bcc: "hidden@example.com",
		});
	});
});

describe("update_draft", () => {
	// A draft as the Gmail UI leaves it after a file is added by hand: the text
	// in an alternative pair, the file beside them, the thread already joined.
	const draft = () => ({
		id: "d1",
		message: {
			id: "dm1",
			threadId: "t-orig",
			payload: {
				mimeType: "multipart/mixed",
				headers: [
					{ name: "To", value: "prof@example.com" },
					{ name: "Cc", value: "assistant@example.com" },
					{ name: "Subject", value: "=?UTF-8?B?5Y6f56i/?=" },
					{ name: "In-Reply-To", value: "<orig@mail.example.com>" },
					{ name: "References", value: "<root@mail.example.com> <orig@mail.example.com>" },
				],
				parts: [
					{
						mimeType: "multipart/alternative",
						parts: [
							{ mimeType: "text/plain", body: { data: b64url("old text") } },
							{ mimeType: "text/html", body: { data: b64url("<p>old text</p>") } },
						],
					},
					{
						mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						filename: "main.docx",
						body: { attachmentId: "att-1", size: 12 },
					},
				],
			},
		},
	});

	const serve = () =>
		serveGmail([
			[/\/drafts\/d1\?format=full/, () => draft()],
			[/\/messages\/dm1\/attachments\/att-1/, () => ({ size: 12, data: b64url("docx bytes!!") })],
			[/\/drafts\/d1$/, () => ({ id: "d1", message: { id: "dm2", threadId: "t-orig" } })],
		]);

	test("a body change keeps the file, the recipients, and the thread", async () => {
		const { handlers } = await boot();
		serve();
		const out = result(await tool(handlers, "update_draft")({ draftId: "d1", body: "new text" }));
		expect(out.attachments).toEqual(["main.docx"]);
		expect(out).toMatchObject({ to: "prof@example.com", cc: "assistant@example.com" });

		const put = requests.find((r) => r.method === "PUT");
		const posted = (put?.body ?? {}) as { message?: { threadId?: string } };
		expect(posted.message?.threadId).toBe("t-orig");

		const mime = sentMime("/drafts/d1", "PUT");
		expect(mime).toContain("To: prof@example.com");
		expect(mime).toContain("Cc: assistant@example.com");
		expect(mime).toContain("In-Reply-To: <orig@mail.example.com>");
		expect(mime).toContain("References: <root@mail.example.com> <orig@mail.example.com>");
		expect(mime).toContain('filename="main.docx"');
		expect(mime).toContain(btoa("docx bytes!!"));
		expect(mime).toContain(btoa("new text"));
	});

	test("a subject change keeps the text as written", async () => {
		const { handlers } = await boot();
		serve();
		await tool(handlers, "update_draft")({ draftId: "d1", subject: "改稿" });
		const mime = sentMime("/drafts/d1", "PUT");
		expect(mime).toContain(btoa("old text"));
		expect(mime).toContain(btoa("<p>old text</p>"));
	});

	test("an empty attachments list removes the files on purpose", async () => {
		const { handlers } = await boot();
		serve();
		await tool(handlers, "update_draft")({ draftId: "d1", body: "b", attachments: [] });
		const mime = sentMime("/drafts/d1", "PUT");
		expect(mime).not.toContain("main.docx");
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
	});

	test("refuses to rebuild when a file cannot be read back", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/drafts\/d1\?format=full/, () => draft()],
			[
				/\/messages\/dm1\/attachments\/att-1/,
				() => new Response(JSON.stringify({ error: "gone" }), { status: 404 }),
			],
			[/\/drafts\/d1$/, () => ({ id: "d1" })],
		]);
		await expect(tool(handlers, "update_draft")({ draftId: "d1", body: "b" })).rejects.toThrow(
			/could not be read back/,
		);
		expect(requests.filter((r) => r.method === "PUT")).toHaveLength(0);
	});

	// An address header goes back as Gmail holds it. Decoded first, a display
	// name's comma split the list, so a name carrying an address became a
	// recipient of a draft whose owner only asked for the text to be tidied.
	const word = (s: string) =>
		`=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
	const addressedAs = (headers: { name: string; value: string }[]) =>
		serveGmail([
			[
				/\/drafts\/d1\?format=full/,
				() => ({
					id: "d1",
					message: {
						id: "dm1",
						payload: {
							mimeType: "text/plain",
							headers: [...headers, { name: "Subject", value: "s" }],
							body: { data: b64url("old text") },
						},
					},
				}),
			],
			[/\/drafts\/d1$/, () => ({ id: "d1", message: { id: "dm2" } })],
		]);

	test("never turns an encoded display name into a recipient", async () => {
		const { handlers } = await boot();
		const crafted = `${word("spy@evil.example, Jöhn Smith")} <john@company.example>`;
		addressedAs([
			{ name: "To", value: crafted },
			{ name: "Bcc", value: `${word("spy2@evil.example, Ann")} <ann@company.example>` },
		]);
		const out = result(await tool(handlers, "update_draft")({ draftId: "d1", body: "polished" }));
		const headers = (sentMime("/drafts/d1", "PUT").split("\r\n\r\n")[0] ?? "").replace(
			/\r\n[ \t]+/g,
			" ",
		);
		expect(headers).toContain(`To: ${crafted}\r\n`);
		expect(headers).not.toContain("spy@evil.example");
		expect(headers).not.toContain("spy2@evil.example");
		expect(out.to).toBe(crafted);
	});

	// Exchange directories write names as "Last, First". This server encodes a
	// non-ASCII one into a single word, which an update used to split in two.
	test("keeps a non-ASCII Last, First name whole", async () => {
		const { handlers } = await boot();
		const written = `${word("Doe, Jöhn")} <john@x.example>`;
		addressedAs([{ name: "To", value: written }]);
		await tool(handlers, "update_draft")({ draftId: "d1", body: "b" });
		expect(sentMime("/drafts/d1", "PUT")).toContain(`To: ${written}\r\n`);
	});

	// Gmail can hand a long header back folded; the fold is not part of it.
	test("unfolds an address header before rebuilding with it", async () => {
		const { handlers } = await boot();
		addressedAs([{ name: "To", value: "a@example.com,\r\n b@example.com" }]);
		const out = result(await tool(handlers, "update_draft")({ draftId: "d1", body: "b" }));
		expect(out.to).toBe("a@example.com, b@example.com");
		expect(sentMime("/drafts/d1", "PUT")).toContain("To: a@example.com, b@example.com");
	});
});

describe("send_draft", () => {
	const draftWith = (headers: { name: string; value: string }[]) => () => ({
		id: "d1",
		message: { id: "dm1", payload: { headers } },
	});
	const sends = () => requests.filter((r) => r.url.includes("/drafts/send"));
	const serve = (headers: { name: string; value: string }[]) =>
		serveGmail([
			[/\/drafts\/d1\?format=metadata/, draftWith(headers)],
			[/\/drafts\/send/, () => ({ id: "sent", threadId: "t1", labelIds: ["SENT"] })],
		]);
	const withBcc = [
		{ name: "To", value: "Alice <alice@x.example>" },
		{ name: "Cc", value: "c@x.example" },
		{ name: "Bcc", value: "spy@evil.example" },
	];

	// A draft carries whatever was last written to it, Bcc included, while the
	// approval a send waited on showed only an opaque id.
	test("refuses a list that leaves out the Bcc, and names it", async () => {
		const { handlers } = await boot();
		serve(withBcc);
		await expect(
			tool(
				handlers,
				"send_draft",
			)({ draftId: "d1", recipients: ["alice@x.example", "c@x.example"] }),
		).rejects.toThrow("this would reach alice@x.example, c@x.example, spy@evil.example.");
		expect(sends()).toHaveLength(0);
		expect(requests[0]?.url).toContain("metadataHeaders=Bcc");
	});

	test("sends once everyone on it is named", async () => {
		const { handlers } = await boot();
		serve(withBcc);
		const out = result(
			await tool(
				handlers,
				"send_draft",
			)({ draftId: "d1", recipients: ["spy@evil.example", "C@x.example", "alice@x.example"] }),
		);
		expect(out.id).toBe("sent");
		expect(sends().map((r) => r.body)).toEqual([{ id: "d1" }]);
	});

	// Gmail delivers "<alice@x.example>" <spy@evil.example> to spy, and this
	// server used to read it as alice, so a list naming alice let spy have the
	// mail. Neither reading can be trusted to match Gmail's, so neither passes.
	test("refuses a recipient whose name could pass for another address", async () => {
		const { handlers } = await boot();
		serve([
			{ name: "To", value: "alice@x.example" },
			{ name: "Bcc", value: '"<alice@x.example>" <spy@evil.example>' },
		]);
		for (const recipients of [["alice@x.example"], ["alice@x.example", "spy@evil.example"]]) {
			await expect(tool(handlers, "send_draft")({ draftId: "d1", recipients })).rejects.toThrow(
				/more than one address/,
			);
		}
		expect(sends()).toHaveLength(0);
	});

	// Receivers join a bare address to what sits beside it, so this draft goes
	// to boss@company.com.evil.example while it reads as boss@company.com.
	test("refuses a bare address with more joined to it", async () => {
		const { handlers } = await boot();
		serve([{ name: "To", value: "boss@company.com(c).evil.example" }]);
		await expect(
			tool(handlers, "send_draft")({ draftId: "d1", recipients: ["boss@company.com"] }),
		).rejects.toThrow(/more than one address/);
		expect(sends()).toHaveLength(0);
	});

	// A client other than this server may write a field twice.
	test("counts a field written twice", async () => {
		const { handlers } = await boot();
		serve([
			{ name: "To", value: "a@x.example" },
			{ name: "Bcc", value: "b@x.example" },
			{ name: "Bcc", value: "spy@evil.example" },
		]);
		await expect(
			tool(handlers, "send_draft")({ draftId: "d1", recipients: ["a@x.example", "b@x.example"] }),
		).rejects.toThrow(/spy@evil\.example/);
		expect(sends()).toHaveLength(0);
	});
});

describe("list_drafts", () => {
	// Sending a draft reaches its Cc and Bcc as well as its To, and answers to
	// it go to its Reply-To; a listing that shows only To hides all three.
	test("shows everyone a draft reaches and where answers to it go", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/drafts\?/, () => ({ drafts: [{ id: "d1" }] })],
			[
				/\/drafts\/d1\?format=metadata/,
				() => ({
					id: "d1",
					message: {
						id: "dm1",
						payload: {
							headers: [
								{ name: "To", value: "alice@x.example" },
								{ name: "Cc", value: "c@x.example" },
								{ name: "Bcc", value: "spy2@evil.example" },
								{ name: "Reply-To", value: "answers@evil.example" },
								{ name: "Subject", value: "s" },
							],
						},
					},
				}),
			],
		]);
		const out = result(await tool(handlers, "list_drafts")({ maxResults: 10 }));
		expect((out.drafts as Record<string, unknown>[])[0]).toMatchObject({
			draftId: "d1",
			to: "alice@x.example",
			cc: "c@x.example",
			bcc: "spy2@evil.example",
			replyTo: "answers@evil.example",
		});
		const read = requests.find((r) => r.url.includes("/drafts/d1"))?.url ?? "";
		expect(read).toContain("metadataHeaders=Bcc");
		expect(read).toContain("metadataHeaders=Reply-To");
	});
});

describe("the label tools", () => {
	// Trash and Spam are emptied after 30 days, and one batch call reaches a
	// thousand messages. Disposal goes through the tools named for it.
	test.each([
		["modify_labels", { messageId: "m1", addLabelIds: ["TRASH"] }],
		["modify_thread_labels", { threadId: "t1", addLabelIds: ["STARRED", "SPAM"] }],
		["batch_modify_messages", { messageIds: ["m1", "m2"], addLabelIds: ["trash"] }],
	])("%s will not trash or mark spam", async (name, args) => {
		const { handlers } = await boot();
		serveGmail([[/./, () => ({})]]);
		await expect(tool(handlers, name)({ removeLabelIds: [], ...args })).rejects.toThrow(
			/trash_message or trash_thread/,
		);
		expect(requests).toHaveLength(0);
	});

	test("still files and archives, and can take mail out of the trash", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\/modify/, () => ({ id: "m1", labelIds: ["STARRED"] })]]);
		await tool(
			handlers,
			"modify_labels",
		)({ messageId: "m1", addLabelIds: ["STARRED"], removeLabelIds: ["INBOX", "TRASH"] });
		expect(requests.map((r) => r.body)).toEqual([
			{ addLabelIds: ["STARRED"], removeLabelIds: ["INBOX", "TRASH"] },
		]);
	});
});

describe("staged attachments", () => {
	const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	const begin = async (handlers: Map<string, Handler>) =>
		result(
			await tool(
				handlers,
				"stage_attachment_begin",
			)({ filename: "報告書.docx", contentType: DOCX }),
		);

	test("chunks staged in order travel into a draft", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/drafts$/, () => ({ id: "d1", message: { id: "dm1" } })]]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa("hello!") });
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa(" world") });
		const sealed = result(await tool(handlers, "stage_attachment_finish")({ stagingId }));
		expect(sealed.size).toBe(12);

		await tool(
			handlers,
			"create_draft",
		)({ to: "a@example.com", subject: "s", body: "b", attachments: [{ stagingId }] });
		const mime = sentMime("/drafts", "POST");
		expect(mime).toContain(btoa("hello! world"));
		// The staged name rides along, RFC 2231-encoded for its non-ASCII characters.
		expect(mime).toContain("filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.docx");
	});

	test("append refuses base64 that cannot be joined", async () => {
		const { handlers } = await boot();
		serveGmail([]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await expect(
			tool(handlers, "stage_attachment_append")({ stagingId, content: "abc" }),
		).rejects.toThrow(/four-character groups/);
	});

	test("an unfinished staging cannot be attached", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/drafts$/, () => ({ id: "d1" })]]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa("abc") });
		await expect(
			tool(
				handlers,
				"create_draft",
			)({ to: "a@example.com", subject: "s", body: "b", attachments: [{ stagingId }] }),
		).rejects.toThrow(/not finished/);
	});

	test("content and stagingId together are refused", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/drafts$/, () => ({ id: "d1" })]]);
		await expect(
			tool(
				handlers,
				"create_draft",
			)({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [
					{ filename: "a.txt", contentType: "text/plain", content: "YQ==", stagingId: "s-1" },
				],
			}),
		).rejects.toThrow(/never both/);
	});

	test("an upload of raw bytes seals the staging by itself", async () => {
		const { agent, handlers, storage } = await boot();
		serveGmail([[/\/messages\/send/, () => ({ id: "sent", threadId: "t1" })]]);
		const { stagingId, uploadUrl } = (await begin(handlers)) as {
			stagingId: string;
			uploadUrl?: string;
		};
		const meta = storage.get(`staged:${stagingId}`) as { secret: string };
		// The handler was called directly, before any request taught the object
		// its origin, so the URL is assembled the way fetch() would have.
		void uploadUrl;
		const doFetch = (agent as { fetch: (r: Request) => Promise<Response> }).fetch.bind(agent);
		const response = await doFetch(
			new Request(
				`https://gmail.example.com/upload/${encodeURIComponent("streamable-http:session-1")}/${stagingId}/${meta.secret}`,
				{ method: "PUT", body: new TextEncoder().encode("raw file bytes") },
			),
		);
		expect(response.status).toBe(200);
		const sealed = (await response.json()) as { size: number; filename: string };
		expect(sealed.size).toBe(14);
		expect(sealed.filename).toBe("報告書.docx");

		await tool(
			handlers,
			"send_message",
		)({ to: "a@example.com", subject: "s", body: "b", attachments: [{ stagingId }] });
		expect(sentMime("/messages/send")).toContain(btoa("raw file bytes"));
	});

	test("a wrong secret is turned away without a hint", async () => {
		const { agent, handlers } = await boot();
		serveGmail([]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		const doFetch = (agent as { fetch: (r: Request) => Promise<Response> }).fetch.bind(agent);
		const response = await doFetch(
			new Request(
				`https://gmail.example.com/upload/${encodeURIComponent("streamable-http:session-1")}/${stagingId}/not-the-secret`,
				{ method: "PUT", body: "x" },
			),
		);
		expect(response.status).toBe(404);
	});

	// The Worker checks the secret against the address before it wakes the
	// session, so what stage_attachment_begin mints has to pass that check.
	test("an upload URL reaches its staging through the public route, once", async () => {
		const { agent, handlers } = await boot();
		serveGmail([]);
		(agent as { origin: string }).origin = "https://gmail.example.com";
		const doFetch = (agent as { fetch: (r: Request) => Promise<Response> }).fetch.bind(agent);
		const { uploadUrl } = (await begin(handlers)) as { uploadUrl?: string };
		const url = String(uploadUrl);
		expect(url).toStartWith(
			`https://gmail.example.com/upload/${encodeURIComponent("streamable-http:session-1")}/`,
		);

		const { env, woken } = fileRouteEnv(doFetch);
		const put = (body: string) =>
			worker.fetch(new Request(url, { method: "PUT", body }), env, {} as never);
		const response = await put("raw file bytes");
		expect(response.status).toBe(200);
		expect(((await response.json()) as { size: number }).size).toBe(14);
		expect(woken).toEqual(["streamable-http:session-1"]);
		expect((await put("other bytes")).status).toBe(409);
	});

	test("expired stagings are swept when a new one begins", async () => {
		const { handlers, storage } = await boot();
		serveGmail([]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa("old") });
		const key = `staged:${stagingId}`;
		const meta = storage.get(key) as { at: number };
		storage.set(key, { ...meta, at: Date.now() - 25 * 60 * 60 * 1000 });

		await begin(handlers);
		expect(storage.has(key)).toBe(false);
		expect(storage.has(`${key}:chunk:0`)).toBe(false);
	});

	test("the public route rejects what is not an upload address", async () => {
		const malformed = await worker.fetch(
			new Request("https://example.com/upload/only-a-name", { method: "PUT", body: "x" }),
			{} as never,
			{} as never,
		);
		expect(malformed.status).toBe(404);
		const wrongMethod = await worker.fetch(
			new Request("https://example.com/upload/a/b/c"),
			{} as never,
			{} as never,
		);
		expect(wrongMethod.status).toBe(405);
	});
});

describe("get_attachment", () => {
	const withAttachment: ReturnType<typeof message> & {
		payload: { parts?: Record<string, unknown>[] };
	} = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{
					mimeType: "text/csv",
					filename: "report.csv",
					body: { attachmentId: "fresh-id", size: 9 },
					headers: [{ name: "Content-Type", value: 'text/csv; charset="utf-8"' }],
				},
			],
		},
	});

	test("uses the id from this read, not the one the caller held", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withAttachment],
			[/attachments\/fresh-id/, () => ({ size: 9, data: b64url("a,b,c\n1,2") })],
		]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "stale-from-an-earlier-read",
				textOnly: true,
			}),
		);
		expect(out.filename).toBe("report.csv");
		expect(out.text).toBe("a,b,c\n1,2");
	});

	test("refuses to guess between two attachments of the same name", async () => {
		const { handlers } = await boot();
		const twin = {
			mimeType: "text/csv",
			filename: "report.csv",
			body: { attachmentId: "second", size: 9 },
		};
		serveGmail([
			[
				/\/messages\/m1\?format=full/,
				() => ({
					...withAttachment,
					payload: {
						mimeType: "multipart/mixed",
						parts: [...(withAttachment.payload.parts ?? []), twin],
					},
				}),
			],
		]);
		await expect(
			tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "stale",
				filename: "report.csv",
			}),
		).rejects.toThrow(/cannot be told apart/);
	});
});

describe("download links", () => {
	// The declared size decides; the bytes served back are a stand-in.
	const withZip = (size: number) =>
		message("m1", {
			payload: {
				mimeType: "multipart/mixed",
				parts: [
					{ mimeType: "text/plain", body: { data: b64url("body") } },
					{
						mimeType: "text/html",
						filename: "配布資料.zip",
						body: { size, attachmentId: "fresh-id" },
					},
				],
			},
		});

	// fetch() teaches the object where it answers; the handler is called
	// directly here, so the origin is set the way that request would have.
	async function bootAt() {
		const made = await boot();
		(made.agent as { origin: string }).origin = "https://gmail.example.com";
		const doFetch = (made.agent as { fetch: (r: Request) => Promise<Response> }).fetch.bind(
			made.agent,
		);
		return { ...made, doFetch };
	}

	test("a file too large to return inline comes back as a link that serves it", async () => {
		const { handlers, doFetch } = await bootAt();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withZip(2_040_746)],
			[/attachments\/fresh-id/, () => ({ size: 2_040_746, data: b64url("zip bytes") })],
		]);
		const out = result(
			await tool(handlers, "get_attachment")({ messageId: "m1", attachmentId: "stale" }),
		);
		expect(out.contentBase64).toBeUndefined();
		// Offering the link costs no read of the file itself.
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
		const url = String(out.downloadUrl);
		expect(url).toStartWith(
			`https://gmail.example.com/download/${encodeURIComponent("streamable-http:session-1")}/`,
		);

		const response = await doFetch(new Request(url));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("zip bytes");
		// Served as an opaque download, never rendered on this origin.
		expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename*=UTF-8''${encodeURIComponent("配布資料.zip")}`,
		);
	});

	const servesZip = (): [RegExp, Route][] => [
		[/\/messages\/m1\?format=full/, () => withZip(2_040_746)],
		[/attachments\/fresh-id/, () => ({ size: 2_040_746, data: b64url("zip bytes") })],
	];
	const link = async (handlers: Map<string, Handler>) =>
		String(
			result(await tool(handlers, "get_attachment")({ messageId: "m1", attachmentId: "" }))
				.downloadUrl,
		);

	test("a wrong secret or an expired link is turned away", async () => {
		const { handlers, doFetch, storage } = await bootAt();
		serveGmail(servesZip());
		const url = await link(handlers);
		const forged = `${url.slice(0, url.lastIndexOf("/"))}/not-the-secret`;
		expect((await doFetch(new Request(forged))).status).toBe(404);
		// Turning a forgery away does not spend the link it imitated.
		expect((await doFetch(new Request(url))).status).toBe(200);

		const unused = await link(handlers);
		const key = [...storage.keys()].find((k) => k.startsWith("download:")) ?? "";
		const offer = storage.get(key) as { at: number };
		storage.set(key, { ...offer, at: Date.now() - 11 * 60 * 1000 });
		expect((await doFetch(new Request(unused))).status).toBe(404);
	});

	// A link that turns up later in a message, a transcript or a log should be
	// worth nothing by then: the fetch it was minted for has spent it.
	test("a link serves its file once, within ten minutes", async () => {
		const { handlers, doFetch, storage } = await bootAt();
		serveGmail(servesZip());
		const out = result(
			await tool(handlers, "get_attachment")({ messageId: "m1", attachmentId: "" }),
		);
		const lifetime = Date.parse(String(out.expiresAt)) - Date.now();
		expect(lifetime).toBeGreaterThan(9 * 60 * 1000);
		expect(lifetime).toBeLessThanOrEqual(10 * 60 * 1000);

		const url = String(out.downloadUrl);
		expect((await doFetch(new Request(url))).status).toBe(200);
		expect((await doFetch(new Request(url))).status).toBe(404);
		expect([...storage.keys()].filter((k) => k.startsWith("download:"))).toHaveLength(0);
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(1);
	});

	// Spent before Gmail is read, so a second request arriving while the first
	// is still being served finds nothing. The cost is that a failed fetch
	// takes a fresh link, which is one more call.
	test("a fetch that fails still spends its link", async () => {
		const { handlers, doFetch } = await bootAt();
		let gmailDown = false;
		serveGmail([
			[
				/\/messages\/m1\?format=full/,
				() =>
					gmailDown
						? new Response(JSON.stringify({ error: { message: "backend error" } }), {
								status: 500,
							})
						: withZip(2_040_746),
			],
			[/attachments\/fresh-id/, () => ({ size: 2_040_746, data: b64url("zip bytes") })],
		]);
		const url = await link(handlers);
		gmailDown = true;
		expect((await doFetch(new Request(url))).status).toBe(502);
		gmailDown = false;
		expect((await doFetch(new Request(url))).status).toBe(404);
		expect((await doFetch(new Request(await link(handlers)))).status).toBe(200);
	});

	// The Worker checks the secret against the address before it wakes the
	// session, so what get_attachment mints has to pass that check.
	test("a link reaches its session through the public route", async () => {
		const { handlers, doFetch } = await bootAt();
		serveGmail(servesZip());
		const url = await link(handlers);
		const { env, woken } = fileRouteEnv(doFetch);
		const response = await worker.fetch(new Request(url), env, {} as never);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("zip bytes");
		expect(woken).toEqual(["streamable-http:session-1"]);
		expect((await worker.fetch(new Request(url), env, {} as never)).status).toBe(404);
	});

	// Only MCP traffic, which comes through the OAuth boundary, says where this
	// deployment answers. A file address reaches the session with no grant, so
	// whatever scheme and host it came in on must not end up in later links.
	test("a file request does not change the host later links name", async () => {
		const { handlers, doFetch } = await bootAt();
		serveGmail(servesZip());
		const name = encodeURIComponent("streamable-http:session-1");
		expect(
			(await doFetch(new Request(`http://elsewhere.example/download/${name}/x/y`))).status,
		).toBe(404);
		expect(
			(
				await doFetch(
					new Request(`http://elsewhere.example/upload/${name}/x/y`, { method: "PUT", body: "x" }),
				)
			).status,
		).toBe(404);
		expect(await link(handlers)).toStartWith(`https://gmail.example.com/download/${name}/`);
	});

	test("a file one read cannot bring back gets no link", async () => {
		const { handlers } = await bootAt();
		serveGmail([[/\/messages\/m1\?format=full/, () => withZip(5_000_000)]]);
		const out = result(
			await tool(handlers, "get_attachment")({ messageId: "m1", attachmentId: "" }),
		);
		expect(out.downloadUrl).toBeUndefined();
		expect(String(out.error)).toContain("too large for this server to read");
	});

	test("the public route takes only GET", async () => {
		const wrongMethod = await worker.fetch(
			new Request("https://example.com/download/a/b/c", { method: "PUT", body: "x" }),
			{} as never,
			{} as never,
		);
		expect(wrongMethod.status).toBe(405);
		const malformed = await worker.fetch(
			new Request("https://example.com/download/only-a-name"),
			{} as never,
			{} as never,
		);
		expect(malformed.status).toBe(404);
	});
});

describe("the file routes", () => {
	// Starting an object writes storage that nothing ever clears, and the
	// limiter, counted per address and per location, does not stop a sender
	// who rotates addresses. So an address is judged before either is reached.
	const NAME = "streamable-http:session-1";
	const ID = "0b6f7f0e-3f7e-4c43-9d55-2b8f8c1e6a10";
	type Kind = "upload" | "download";
	const address = (kind: Kind, name: string, id: string, secret: string) =>
		`https://example.com/${kind}/${encodeURIComponent(name)}/${id}/${secret}`;
	const send = (env: never, kind: Kind, url: string) =>
		worker.fetch(
			kind === "upload" ? new Request(url, { method: "PUT", body: "x" }) : new Request(url),
			env,
			{} as never,
		);

	test("an address no session minted wakes nothing", async () => {
		const { env, woken, limited } = fileRouteEnv();
		for (const kind of ["upload", "download"] as const) {
			const response = await send(env, kind, address(kind, "attacker-1", ID, "0".repeat(64)));
			expect(response.status).toBe(404);
			expect(await response.text()).toContain("answers to this address");
		}
		expect(woken).toEqual([]);
		expect(limited).toEqual([]);
	});

	test("a malformed escape is a wrong address, not a crash", async () => {
		const { env, woken } = fileRouteEnv();
		for (const kind of ["upload", "download"] as const) {
			for (const path of [`%E0%A4%A/${ID}/s`, `n/%zz/s`, `n/${ID}/%`]) {
				const response = await send(env, kind, `https://example.com/${kind}/${path}`);
				expect(response.status).toBe(404);
			}
		}
		expect(woken).toEqual([]);
	});

	test("a secret opens only the address it was minted for", async () => {
		const { env, woken, limited } = fileRouteEnv();
		const secret = await signData(`download:${NAME}/${ID}`, COOKIE_KEY);
		const elsewhere: [Kind, string][] = [
			["upload", address("upload", NAME, ID, secret)],
			["download", address("download", "streamable-http:session-2", ID, secret)],
			["download", address("download", NAME, crypto.randomUUID(), secret)],
			[
				"download",
				address("download", NAME, ID, await signData(`download:${NAME}/${ID}`, "another-key")),
			],
		];
		for (const [kind, url] of elsewhere) {
			expect((await send(env, kind, url)).status).toBe(404);
		}
		expect(woken).toEqual([]);
		expect(limited).toEqual([]);

		const genuine = await send(env, "download", address("download", NAME, ID, secret));
		expect(genuine.status).toBe(200);
		expect(await genuine.text()).toBe("reached");
		expect(woken).toEqual([NAME]);
		// What passes is still counted: holding a real link is no licence to
		// fetch it without end.
		expect(limited).toHaveLength(1);
	});
});

describe("two attachments that both arrived whole", () => {
	// Gmail gives an id only to a part it externalises, so parts that arrive
	// whole have none and are all published with the same empty one. Matching on
	// that would pick whichever came first and skip the check that refuses to
	// guess.
	const twoSmall = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{ mimeType: "text/csv", filename: "first.csv", body: { size: 7, data: b64url("FIRST,1") } },
				{
					mimeType: "text/csv",
					filename: "second.csv",
					body: { size: 8, data: b64url("SECOND,2") },
				},
			],
		},
	});

	test("returns the one asked for by name", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => twoSmall]]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "second.csv",
				textOnly: true,
			}),
		);
		expect(out.filename).toBe("second.csv");
		expect(out.text).toBe("SECOND,2");
	});

	test("refuses to choose between two of the same name", async () => {
		const { handlers } = await boot();
		const sameName = message("m1", {
			payload: {
				mimeType: "multipart/mixed",
				parts: [
					{ mimeType: "text/csv", filename: "a.csv", body: { size: 2, data: b64url("A1") } },
					{ mimeType: "text/csv", filename: "a.csv", body: { size: 2, data: b64url("A2") } },
				],
			},
		});
		serveGmail([[/\/messages\/m1\?format=full/, () => sameName]]);
		await expect(
			tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "a.csv",
				textOnly: true,
			}),
		).rejects.toThrow(/cannot be told apart/);
	});
});

describe("get_thread", () => {
	test("keeps the newest messages and says how many it dropped", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/threads\//, () => ({ messages: [message("m1"), message("m2"), message("m3")] })],
		]);
		const out = result(await tool(handlers, "get_thread")({ threadId: "t1", maxMessages: 2 }));
		expect(out.messageCount).toBe(3);
		expect(out.omitted).toBe(1);
		expect((out.messages as { id: string }[]).map((m) => m.id)).toEqual(["m2", "m3"]);
	});
});

describe("token handling", () => {
	test("refreshes once when several calls find the token expired", async () => {
		const { agent, handlers } = await boot();
		(agent as { props: { expiresAt: number } }).props.expiresAt = Date.now() - 1000;
		serveGmail([
			[/oauth2\.googleapis\.com/, () => ({ access_token: "fresh", expires_in: 3600 })],
			[/\/messages\?/, () => ({ messages: [] })],
		]);
		await Promise.all([
			tool(handlers, "search_messages")({ query: "a", maxResults: 1 }),
			tool(handlers, "search_messages")({ query: "b", maxResults: 1 }),
		]);
		const refreshes = requests.filter((r) => r.url.includes("oauth2.googleapis.com"));
		expect(refreshes).toHaveLength(1);
	});
});

describe("get_thread on a thread too large to read at once", () => {
	// One read returns every message however few were asked for, so a long
	// thread can be unanswerable. The ids are small; the window is fetched
	// a message at a time from those.
	test("enumerates the ids, then fetches only the window", async () => {
		const { handlers } = await boot();
		const ids = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}` }));
		serveGmail([
			[/\/threads\/[^?]+\?format=minimal/, () => ({ messages: ids })],
			[/\/threads\//, () => new Response("thread too large", { status: 413 })],
			[/\/messages\/m3[89]/, (url) => message(url.match(/m\d+/)?.[0] ?? "m")],
		]);
		const out = result(await tool(handlers, "get_thread")({ threadId: "t1", maxMessages: 2 }));
		expect(out.messageCount).toBe(40);
		expect((out.messages as { id: string }[]).map((m) => m.id)).toEqual(["m38", "m39"]);
		// The whole thread was never fetched a second time.
		expect(requests.filter((r) => /\/messages\/m/.test(r.url))).toHaveLength(2);
	});

	test("asks Gmail only for the headers a summary uses", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/threads\//, () => ({ messages: [message("m1")] })]]);
		await tool(handlers, "get_thread")({ threadId: "t1", includeBodies: false });
		const threadCall = requests.find((r) => r.url.includes("/threads/"));
		expect(threadCall?.url).toContain("metadataHeaders=Subject");
		expect(threadCall?.url).toContain("metadataHeaders=Reply-To");
		expect(threadCall?.url).toContain("metadataHeaders=Bcc");
	});
});

describe("attachments that arrive whole", () => {
	// Gmail externalises a large part and gives it an id; a small one comes back
	// inside the message with no id. Listing only the first kind loses the
	// second, and a forward then goes out without the file.
	const inlineFile = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{
					mimeType: "text/csv",
					filename: "tiny.csv",
					body: { size: 3, data: b64url("a,b") },
				},
			],
		},
	});

	test("lists one that carries its own bytes", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => inlineFile]]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		expect((out.attachments as { filename: string }[]).map((a) => a.filename)).toEqual([
			"tiny.csv",
		]);
	});

	test("returns it without asking Gmail a second time", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => inlineFile]]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "tiny.csv",
				textOnly: true,
			}),
		);
		expect(out.text).toBe("a,b");
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
	});
});

describe("an attachment with no bytes in it", () => {
	// A sender may attach an empty file, and Gmail returns it named with a body
	// of zero length. It is still a file the recipient was sent.
	const withEmpty = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{ mimeType: "text/plain", filename: "empty.txt", body: { size: 0, data: "" } },
				{ mimeType: "text/csv", filename: "real.csv", body: { size: 3, data: b64url("a,b") } },
			],
		},
	});

	test("names it alongside the others", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => withEmpty]]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		expect((out.attachments as { filename: string }[]).map((a) => a.filename)).toEqual([
			"empty.txt",
			"real.csv",
		]);
	});

	// It has no id either, so asking Gmail for it under a blank one is a 404.
	test("returns it without asking Gmail for it", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => withEmpty]]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "empty.txt",
			}),
		);
		expect(out.filename).toBe("empty.txt");
		expect(out.contentBase64).toBe("");
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
	});

	test("carries it into a forward", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withEmpty],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		const out = result(
			await tool(
				handlers,
				"forward_message",
			)({
				messageId: "m1",
				to: "b@example.com",
				includeAttachments: true,
			}),
		);
		expect(out.attachmentsForwarded).toBe(2);
	});
});

describe("a message that arrived as a file", () => {
	// Abuse reports and bounce chains arrive this way: the mail carries another
	// message as an attachment, and that message carries files of its own.
	const enclosing = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("see attached") } },
				{
					mimeType: "message/rfc822",
					filename: "inner.eml",
					body: { size: 900, attachmentId: "ATT-outer" },
					parts: [
						{
							mimeType: "multipart/mixed",
							parts: [
								{ mimeType: "text/plain", body: { data: b64url("inner body") } },
								{
									mimeType: "application/pdf",
									filename: "invoice.pdf",
									body: { size: 500, attachmentId: "ATT-inner" },
								},
							],
						},
					],
				},
			],
		},
	});

	test("names the file inside it, and says where it is", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => enclosing]]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		expect(out.attachments).toEqual([
			expect.objectContaining({ filename: "inner.eml" }),
			expect.objectContaining({ filename: "invoice.pdf", insideForwardedMessage: true }),
		]);
	});

	// Re-attaching it would send the same file twice — once inside the
	// enclosure and once beside it — and charge the forward for both.
	test("forwards the enclosure once, without the file already inside it", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => enclosing],
			[/\/attachments\//, () => ({ size: 900, data: b64url("outer bytes") })],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		const out = result(
			await tool(
				handlers,
				"forward_message",
			)({
				messageId: "m1",
				to: "b@example.com",
				includeAttachments: true,
			}),
		);
		expect(out.attachmentsForwarded).toBe(1);
		expect(requests.filter((r) => r.url.includes("ATT-inner"))).toHaveLength(0);
	});
});

describe("forwarding large attachments", () => {
	// The declared sizes decide; the bytes served back are a stand-in.
	const withFiles = (...sizes: number[]) =>
		message("m1", {
			payload: {
				mimeType: "multipart/mixed",
				parts: [
					{ mimeType: "text/plain", body: { data: b64url("body") } },
					...sizes.map((size, n) => ({
						mimeType: "application/zip",
						filename: `file${n}.zip`,
						body: { size, attachmentId: `ATT-${n}` },
					})),
				],
			},
		});
	const sends = () => requests.filter((r) => r.url.includes("/messages/send"));

	// Too large to hand back to a caller is not too large to forward: the
	// bytes never leave the server.
	test("carries a file larger than a download may return", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withFiles(2_040_746)],
			[/\/attachments\/ATT-0/, () => ({ size: 2_040_746, data: b64url("zip bytes") })],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		const out = result(
			await tool(
				handlers,
				"forward_message",
			)({ messageId: "m1", to: "b@example.com", includeAttachments: true }),
		);
		expect(out.attachmentsForwarded).toBe(1);
		expect(sentMime("/messages/send")).toContain("file0.zip");
	});

	test("refuses, without sending, a file one read cannot bring back", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withFiles(100, 5_000_000)],
			[/\/attachments\//, () => ({ size: 100, data: b64url("small") })],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		await expect(
			tool(
				handlers,
				"forward_message",
			)({ messageId: "m1", to: "b@example.com", includeAttachments: true }),
		).rejects.toThrow(/file1\.zip is too large/);
		expect(sends()).toHaveLength(0);
	});

	test("refuses, without fetching or sending, more than a message can carry", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withFiles(3_100_000, 3_100_000)],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		await expect(
			tool(
				handlers,
				"forward_message",
			)({ messageId: "m1", to: "b@example.com", includeAttachments: true }),
		).rejects.toThrow(/more attachment data than can be forwarded/);
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
		expect(sends()).toHaveLength(0);
	});
});

describe("what a listing carries", () => {
	// A read that only wanted the body should not pay for the attachments. The
	// bytes are fetched when they are asked for, not carried in every listing.
	test("names an inline attachment without embedding it", async () => {
		const { handlers } = await boot();
		const big = b64url("x".repeat(30_000));
		serveGmail([
			[
				/\/messages\/m1\?format=full/,
				() =>
					message("m1", {
						payload: {
							mimeType: "multipart/mixed",
							parts: [
								{ mimeType: "text/plain", body: { data: b64url("body") } },
								{
									mimeType: "image/png",
									filename: "shot.png",
									body: { size: 30_000, data: big },
								},
							],
						},
					}),
			],
		]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		const listed = (out.attachments as Record<string, unknown>[])[0];
		expect(listed?.filename).toBe("shot.png");
		expect(listed).not.toHaveProperty("data");
		expect(JSON.stringify(out).length).toBeLessThan(5_000);
	});
});

describe("the public OAuth endpoints", () => {
	// A sender that omits Content-Length picks how much memory the request
	// occupies, and neither endpoint asks for credentials first. What matters is
	// that the refusal happens part-way, so the count is of what was pulled off
	// the stream rather than of what was offered.
	const CHUNK = 64 * 1024;
	const streamed = (path: string, chunks: number) => {
		let pulled = 0;
		const request = new Request(`https://example.com${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new ReadableStream({
				pull(controller) {
					if (pulled >= chunks) return controller.close();
					pulled += 1;
					controller.enqueue(new Uint8Array(CHUNK));
				},
			}),
			duplex: "half",
		});
		return { request, offered: () => pulled };
	};

	// A client registers once and keeps its id, so a caller asking repeatedly is
	// spending a KV write that the grants and tokens of connected accounts need.
	test("turns away a caller registering over and over", async () => {
		const asked: string[] = [];
		const env = {
			REGISTER_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					asked.push(key);
					return { success: asked.length <= 1 };
				},
			},
		};
		const register = () =>
			worker.fetch(
				new Request("https://example.com/register", {
					method: "POST",
					headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
					body: "{}",
				}),
				env as never,
				{} as never,
			);
		expect((await register()).status).not.toBe(429);
		expect((await register()).status).toBe(429);
		expect(asked).toEqual(["203.0.113.9", "203.0.113.9"]);
	});

	// A /64 belongs to one subscriber, so walking its addresses must not buy a
	// fresh allowance each time.
	test("counts every address in an IPv6 /64 as one registering caller", async () => {
		const asked: string[] = [];
		const env = {
			REGISTER_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					asked.push(key);
					return { success: asked.length <= 1 };
				},
			},
		};
		const register = (address: string) =>
			worker.fetch(
				new Request("https://example.com/register", {
					method: "POST",
					headers: { "Content-Type": "application/json", "CF-Connecting-IP": address },
					body: "{}",
				}),
				env as never,
				{} as never,
			);
		expect((await register("2001:db8:1:2::a")).status).not.toBe(429);
		expect((await register("2001:db8:1:2:ffff::b")).status).toBe(429);
		expect(asked).toEqual(["2001:db8:1:2::/64", "2001:db8:1:2::/64"]);
	});

	// Each sign-in step stores or spends a state, so each is metered before
	// anything is read or stored. Hono decodes a path before routing it, and a
	// percent-encoded spelling reaches the same handler, so it meets the same
	// limit.
	test("meters every sign-in step before KV, however its path is spelled", async () => {
		const asked: string[] = [];
		const touched: string[] = [];
		const kv = {
			get: async (key: string) => {
				touched.push(`get ${key}`);
				return null;
			},
			put: async (key: string) => {
				touched.push(`put ${key}`);
			},
			delete: async (key: string) => {
				touched.push(`delete ${key}`);
			},
		};
		const env = {
			OAUTH_KV: kv,
			REGISTER_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					asked.push(key);
					return { success: false };
				},
			},
		};
		const steps = [
			["GET", "/authorize"],
			["HEAD", "/authorize"],
			["POST", "/authorize"],
			["GET", "/callback"],
			["GET", "/%61uthorize"],
			["POST", "/%61uthorize"],
			["GET", "/%63allback"],
		] as const;
		for (const [method, path] of steps) {
			const response = await worker.fetch(
				new Request(`https://example.com${path}?client_id=c&state=s&code=x`, {
					method,
					headers: { "CF-Connecting-IP": "203.0.113.9" },
				}),
				env as never,
				{} as never,
			);
			expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 429`);
		}
		expect(asked).toEqual(steps.map(() => "203.0.113.9"));
		expect(touched).toEqual([]);
	});

	// The MCP endpoint has a ceiling of its own, and a streamed message slips
	// past it the same way. This one needs a grant, so it is reached only by
	// someone already allowed to connect.
	test("stops reading an oversized MCP message", async () => {
		const { request, offered } = streamed("/mcp", 128);
		const response = await worker.fetch(request, {} as never, {} as never);
		expect(response.status).toBe(413);
		expect(offered()).toBeLessThan(80);
	});

	for (const path of ["/token", "/register"]) {
		test(`stops reading a body too large to hold at ${path}`, async () => {
			const { request, offered } = streamed(path, 512);
			const response = await worker.fetch(request, {} as never, {} as never);
			expect(response.status).toBe(413);
			// 32 MiB was on offer; a couple of chunks is all it takes to know.
			expect(offered()).toBeLessThan(8);
		});
	}
});

describe("who may register and sign in", () => {
	const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

	// The provider stores clients as JSON and reads them back parsed.
	function memoryKv() {
		const store = new Map<string, string>();
		return {
			store,
			get: async (key: string, options?: { type?: string }) => {
				const value = store.get(key) ?? null;
				return value !== null && options?.type === "json" ? JSON.parse(value) : value;
			},
			put: async (key: string, value: string) => {
				store.set(key, value);
			},
			delete: async (key: string) => {
				store.delete(key);
			},
		};
	}

	const clients = (kv: ReturnType<typeof memoryKv>) =>
		[...kv.store.keys()].filter((key) => key.startsWith("client:"));

	const register = (kv: ReturnType<typeof memoryKv>, redirectUris: string[]) =>
		worker.fetch(
			new Request("https://example.com/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_name: "Claude",
					redirect_uris: redirectUris,
					token_endpoint_auth_method: "none",
				}),
			}),
			{ OAUTH_KV: kv } as never,
			{} as never,
		);

	// Each of these used to register, and stayed in KV for the decade a
	// registration lasts.
	test.each([
		["another host", ["https://evil.example/cb"]],
		["an app scheme", ["microsoft-edge:https://claude.ai/api/mcp/auth_callback"]],
		["a loopback callback", ["http://localhost:33418/callback"]],
	])("refuses to register a client whose only redirect is %s", async (_name, uris) => {
		const kv = memoryKv();
		const response = await register(kv, uris);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error?: string }).error).toBe("invalid_client_metadata");
		expect(clients(kv)).toEqual([]);
	});

	test.each([
		["claude.ai", [CLAUDE]],
		["claude.com", ["https://claude.com/api/mcp/auth_callback"]],
		["Claude beside another redirect", [CLAUDE, "https://evil.example/cb"]],
	])("registers a client that names %s", async (_name, uris) => {
		const kv = memoryKv();
		const response = await register(kv, uris);
		expect(response.status).toBe(201);
		expect(clients(kv)).toHaveLength(1);
	});

	// The provider hands the registration check no env, so the Worker reads the
	// setting from the runtime's module-level copy, which is what this sets.
	test("registers by ALLOWED_REDIRECT_URIS when it is set", async () => {
		const { env: runtimeEnv } = (await import("cloudflare:workers")) as unknown as {
			env: Record<string, string | undefined>;
		};
		runtimeEnv.ALLOWED_REDIRECT_URIS = "https://app.example/oauth/callback";
		try {
			const kv = memoryKv();
			expect((await register(kv, ["https://app.example/oauth/callback"])).status).toBe(201);
			expect((await register(kv, [CLAUDE])).status).toBe(400);
			expect(clients(kv)).toHaveLength(1);
		} finally {
			delete runtimeEnv.ALLOWED_REDIRECT_URIS;
		}
	});

	// Registering beside Claude's callback must not make the other redirect usable.
	test("refuses, at /authorize, a registered redirect that is not Claude's", async () => {
		const kv = memoryKv();
		const registered = await register(kv, [CLAUDE, "https://evil.example/cb"]);
		const { client_id } = (await registered.json()) as { client_id: string };
		const authorize = (redirectUri: string) =>
			worker.fetch(
				new Request(
					`https://example.com/authorize?${new URLSearchParams({
						response_type: "code",
						client_id,
						redirect_uri: redirectUri,
						code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
						code_challenge_method: "S256",
						state: "s",
					})}`,
				),
				{ OAUTH_KV: kv } as never,
				{} as never,
			);
		const elsewhere = await authorize("https://evil.example/cb");
		expect(elsewhere.status).toBe(400);
		expect(await elsewhere.text()).toBe("This server only signs in Claude.");
		const claude = await authorize(CLAUDE);
		expect(claude.status).toBe(200);
		expect(await claude.text()).toContain("is requesting access");
	});
});

describe("the headers the boundary hands on", () => {
	// The account header is stamped from the decrypted grant, and the framework
	// will read a whole grant out of x-partykit-props if a client writes one.
	// Neither belongs to the client, so neither survives the boundary.
	test("drops a client's own account and props headers", async () => {
		const seen: Headers[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			seen.push(new Request(input).headers);
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		try {
			await worker.fetch(
				new Request("https://example.com/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-gmail-mcp-account": "intruder@example.com",
						"x-partykit-props": "eyJlbWFpbCI6ImludHJ1ZGVyQGV4YW1wbGUuY29tIn0=",
					},
					body: "{}",
				}),
				{} as never,
				{} as never,
			);
		} catch {
			// The provider refuses the unauthenticated call; what matters is that
			// nothing downstream ever saw the client's headers.
		} finally {
			globalThis.fetch = original;
		}
		for (const headers of seen) {
			expect(headers.get("x-partykit-props")).toBeNull();
			expect(headers.get("x-gmail-mcp-account")).toBeNull();
		}
	});
});

describe("when the account's identities cannot be read", () => {
	// Which addresses are this account's own decides who a reply comes from and
	// who it copies. A reply is sent once, so a lookup that cannot answer must
	// not fall through to answering as the primary address.
	test("does not send the reply", async () => {
		const { handlers } = await boot();
		serveGmail([
			[
				/\/settings\/sendAs/,
				() => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
			],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		await expect(
			tool(
				handlers,
				"reply_all",
			)({
				messageId: "m1",
				recipients: ["alice@example.com", "bob@example.com", "carol@example.com"],
				body: "ok",
			}),
		).rejects.toThrow(/send-as identities/);
		expect(requests.filter((r) => r.url.includes("/messages/send"))).toHaveLength(0);
	});

	// A day-old answer is a better guide than none, and it keeps replies working
	// through a passing failure of the settings endpoint.
	test("falls back to the answer it was given before", async () => {
		const { agent, handlers, storage } = await boot();
		storage.set("sendAs", {
			at: Date.now() - 48 * 60 * 60 * 1000,
			addresses: ["me@example.com", "sales@example.com"],
		});
		void agent;
		serveGmail([
			[
				/\/settings\/sendAs/,
				() => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
			],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const out = result(
			await tool(
				handlers,
				"reply_all",
			)({
				messageId: "m1",
				recipients: ["alice@example.com", "bob@example.com", "carol@example.com"],
				body: "ok",
			}),
		);
		expect(out.to).toEqual(["alice@example.com"]);
	});
});

describe("forwarding a long message", () => {
	// A quotation may be trimmed because the reader already has the original.
	// A forward is the original, and the person it reaches has no other copy.
	const long = Array.from(
		{ length: 300 },
		(_, i) => `Paragraph ${i}: this is an ordinary sentence of the kind a report is made of.`,
	).join("\n\n");

	test("carries the whole body, not a quotation's worth of it", async () => {
		const { handlers } = await boot();
		const report = message("m1", {
			payload: {
				mimeType: "text/plain",
				headers: [
					{ name: "From", value: "Alice <alice@example.com>" },
					{ name: "To", value: "me@example.com" },
					{ name: "Subject", value: "Quarterly report" },
				],
				body: { data: b64url(long) },
			},
		});
		serveGmail([
			[/\/messages\/m1\?format=full/, () => report],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		await tool(handlers, "forward_message")({ messageId: "m1", to: "b@example.com" });

		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const mime = new TextDecoder().decode(
			Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
		);
		const carried = new TextDecoder().decode(
			Uint8Array.from(atob((mime.split("\r\n\r\n")[1] ?? "").replace(/\r\n/g, "")), (c) =>
				c.charCodeAt(0),
			),
		);
		expect(carried).toContain("Paragraph 299:");
		expect(carried).not.toContain("truncated:");
	});
});

describe("tool annotations", () => {
	const sends = ["send_message", "reply_all", "forward_message", "send_draft"];
	const destroys = [
		"trash_message",
		"trash_thread",
		"delete_draft",
		"delete_label",
		"update_draft",
		"modify_labels",
		"modify_thread_labels",
		"batch_modify_messages",
	];

	// A client decides from these which calls run without asking. A tool that
	// declares none counts as a destructive write, so reads and sends share one
	// permission, and allowing the searches allows the sends with them.
	test("every tool declares them", async () => {
		const { handlers, annotations } = await boot();
		expect(handlers.size).toBe(27);
		const bare = [...handlers.keys()].filter(
			(name) => typeof annotations.get(name)?.readOnlyHint !== "boolean",
		);
		expect(bare).toEqual([]);
	});

	test("nothing that sends or destroys claims to only read", async () => {
		const { annotations } = await boot();
		for (const name of [...sends, ...destroys]) {
			expect(annotations.get(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		}
		for (const name of sends) {
			expect(annotations.get(name)?.openWorldHint).toBe(true);
		}
		const reads = [...annotations]
			.filter(([, hints]) => hints?.readOnlyHint === true)
			.map(([name]) => name)
			.sort();
		expect(reads).toEqual([
			"get_attachment",
			"get_message",
			"get_thread",
			"list_drafts",
			"list_labels",
			"search_messages",
			"whoami",
		]);
	});

	// The stub sees only what was passed. The SDK decides what a client is
	// told, and an annotations object it took for a schema would never get
	// there, so the listing is read the way a client reads it.
	test("reach a client in the tool listing", async () => {
		const made = makeAgent();
		const server = new McpServer({ name: "test", version: "0" });
		made.agent.server = server;
		await (made.agent as { init: () => Promise<void> }).init();
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const client = new Client({ name: "test", version: "0" });
		await client.connect(clientSide);
		try {
			const { tools } = await client.listTools();
			expect(tools).toHaveLength(27);
			expect(tools.filter((t) => t.annotations === undefined).map((t) => t.name)).toEqual([]);
			const listed = (name: string) => tools.find((t) => t.name === name);
			expect(listed("send_draft")?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true,
			});
			expect(listed("whoami")?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
			// The approval card shows what was passed, so the list has to be.
			expect(listed("reply_all")?.inputSchema.required).toContain("recipients");
			expect(listed("send_draft")?.inputSchema.required).toContain("recipients");
		} finally {
			await client.close();
		}
	});
});
