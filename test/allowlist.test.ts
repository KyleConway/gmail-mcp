import { describe, expect, test } from "bun:test";
import {
	allowedRedirects,
	isAllowedRedirect,
	isAutoPinEnabled,
	isClaudeRedirect,
	isClientAllowed,
	isEmailAllowed,
	isUnderAccountCap,
	parseLimit,
	pinKey,
	registrationRefusal,
} from "../src/utils";

describe("isEmailAllowed", () => {
	test("admits no one when unset or empty", () => {
		expect(isEmailAllowed("a@example.com", undefined)).toBe(false);
		expect(isEmailAllowed("a@example.com", "")).toBe(false);
		expect(isEmailAllowed("a@example.com", "  , ,  ")).toBe(false);
	});

	test("matches exact addresses case-insensitively", () => {
		expect(isEmailAllowed("A@Example.com", "a@example.com")).toBe(true);
		expect(isEmailAllowed("a@example.com", "b@example.com, a@example.com")).toBe(true);
		expect(isEmailAllowed("c@example.com", "a@example.com,b@example.com")).toBe(false);
	});

	test("matches a domain pattern only within that domain", () => {
		expect(isEmailAllowed("anyone@example.com", "*@example.com")).toBe(true);
		expect(isEmailAllowed("anyone@other.com", "*@example.com")).toBe(false);
		// A lookalike domain must not pass.
		expect(isEmailAllowed("attacker@notexample.com", "*@example.com")).toBe(false);
		expect(isEmailAllowed("attacker@example.com.evil.net", "*@example.com")).toBe(false);
	});

	test("wildcard admits any address", () => {
		expect(isEmailAllowed("anyone@anywhere.org", "*")).toBe(true);
		expect(isEmailAllowed("someone@gmail.com", "a@example.com, *")).toBe(true);
	});

	test("a bare domain without the star does not match its addresses", () => {
		expect(isEmailAllowed("a@example.com", "example.com")).toBe(false);
	});
});

describe("isUnderAccountCap", () => {
	test("lets a known account through whatever the count", () => {
		expect(isUnderAccountCap(999, false, 25)).toBe(true);
		expect(isUnderAccountCap(999, false, 0)).toBe(true);
	});

	test("admits a new account below the cap and refuses it at the cap", () => {
		expect(isUnderAccountCap(24, true, 25)).toBe(true);
		expect(isUnderAccountCap(25, true, 25)).toBe(false);
		expect(isUnderAccountCap(26, true, 25)).toBe(false);
	});

	test("a cap of zero or less admits nobody new", () => {
		expect(isUnderAccountCap(0, true, 0)).toBe(false);
		expect(isUnderAccountCap(0, true, -1)).toBe(false);
		expect(isUnderAccountCap(0, true, Number.NaN)).toBe(false);
	});

	// A KV listing stops at 1000 keys, so a caller that cannot count the accounts
	// says so with an unbounded count rather than reporting the truncated one.
	test("an uncountable number of accounts refuses a new one", () => {
		expect(isUnderAccountCap(Number.POSITIVE_INFINITY, true, 25)).toBe(false);
		expect(isUnderAccountCap(Number.POSITIVE_INFINITY, true, 5000)).toBe(false);
		expect(isUnderAccountCap(Number.POSITIVE_INFINITY, false, 25)).toBe(true);
	});
});

describe("parseLimit", () => {
	test("reads a positive integer", () => {
		expect(parseLimit("50", 25)).toBe(50);
	});

	test("falls back on anything unusable", () => {
		expect(parseLimit(undefined, 25)).toBe(25);
		expect(parseLimit("", 25)).toBe(25);
		expect(parseLimit("nope", 25)).toBe(25);
		expect(parseLimit("0", 25)).toBe(25);
		expect(parseLimit("-5", 25)).toBe(25);
	});
});

describe("isClaudeRedirect", () => {
	test("accepts Claude's own callbacks", () => {
		expect(isClaudeRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
		expect(isClaudeRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
	});

	// The first three registered and had their codes redeemed against the
	// provider's own checks, which only compare a redirect with what the client
	// registered for itself.
	test.each([
		["a look-alike host", "https://\u0441laude.ai/api/mcp/auth_callback"],
		["an app scheme wrapping it", "microsoft-edge:https://claude.ai/api/mcp/auth_callback"],
		["a userinfo prefix", "https://claude.ai:443@evil.example/api/mcp/auth_callback"],
		["a subdomain", "https://evil.claude.ai/api/mcp/auth_callback"],
		["a suffixed host", "https://claude.ai.evil.example/api/mcp/auth_callback"],
		["plain http", "http://claude.ai/api/mcp/auth_callback"],
		["a query string", "https://claude.ai/api/mcp/auth_callback?next=https://evil.example"],
		["a trailing slash", "https://claude.ai/api/mcp/auth_callback/"],
		["a loopback host", "http://localhost:33418/callback"],
		["a loopback address", "http://127.0.0.1:33418/callback"],
		["nothing at all", ""],
	])("refuses %s", (_name, uri) => {
		expect(isClaudeRedirect(uri)).toBe(false);
	});
});

describe("isAllowedRedirect", () => {
	const CLAUDE_AI = "https://claude.ai/api/mcp/auth_callback";
	const CLAUDE_COM = "https://claude.com/api/mcp/auth_callback";

	// Leaving the setting out must keep the deployment exactly as strict as it
	// was before the setting existed.
	test.each([
		["unset", undefined],
		["empty", ""],
		["only separators", " , ,"],
	])("falls back to Claude's callbacks when %s", (_name, raw) => {
		expect([...allowedRedirects(raw)].sort()).toEqual([CLAUDE_AI, CLAUDE_COM]);
		expect(isAllowedRedirect(CLAUDE_AI, raw)).toBe(true);
		expect(isAllowedRedirect("http://localhost:33418/callback", raw)).toBe(false);
	});

	test("replaces the default with the operator's list", () => {
		const raw = ` ${CLAUDE_AI} , https://app.example/oauth/callback `;
		expect(isAllowedRedirect(CLAUDE_AI, raw)).toBe(true);
		expect(isAllowedRedirect("https://app.example/oauth/callback", raw)).toBe(true);
		// Not listed, so no longer accepted, even though it is Claude's.
		expect(isAllowedRedirect(CLAUDE_COM, raw)).toBe(false);
	});

	// An entry is a whole URI, never a prefix or a pattern.
	test.each([
		["a longer path", "https://app.example/oauth/callback/evil"],
		["a query string", "https://app.example/oauth/callback?next=https://evil.example"],
		["a different port", "https://app.example:8443/oauth/callback"],
		["a userinfo prefix", "https://app.example@evil.example/oauth/callback"],
		["a subdomain", "https://evil.app.example/oauth/callback"],
		["different case", "https://APP.example/oauth/callback"],
		["plain http", "http://app.example/oauth/callback"],
	])("matches exactly, refusing %s", (_name, uri) => {
		expect(isAllowedRedirect(uri, "https://app.example/oauth/callback")).toBe(false);
	});

	test("treats a wildcard as a literal string, not a pattern", () => {
		expect(isAllowedRedirect("https://evil.example/cb", "*")).toBe(false);
		expect(isAllowedRedirect("https://evil.example/cb", "https://*")).toBe(false);
	});
});

describe("registrationRefusal", () => {
	test("registers a client listing one allowed callback among others", () => {
		expect(
			registrationRefusal(
				["https://claude.ai/api/mcp/auth_callback", "https://future.claude.ai/cb"],
				undefined,
			),
		).toBeUndefined();
	});

	test.each([
		["no allowed callback", ["https://evil.example/cb"]],
		["an empty list", []],
		["no list at all", undefined],
		["a list of the wrong type", "https://claude.ai/api/mcp/auth_callback"],
		["non-string entries", [42, null]],
	])("refuses %s", (_name, uris) => {
		expect(registrationRefusal(uris, undefined)?.description).toContain("only registers Claude");
	});

	test("follows ALLOWED_REDIRECT_URIS when it is set", () => {
		const raw = "https://app.example/oauth/callback";
		expect(registrationRefusal([raw], raw)).toBeUndefined();
		expect(
			registrationRefusal(["https://claude.ai/api/mcp/auth_callback"], raw)?.description,
		).toContain("ALLOWED_REDIRECT_URIS");
	});
});

describe("isClientAllowed", () => {
	test("pins nothing when unset or empty", () => {
		expect(isClientAllowed("any-client", undefined)).toBe(true);
		expect(isClientAllowed("any-client", "")).toBe(true);
		expect(isClientAllowed("any-client", "  , ,  ")).toBe(true);
	});

	test("admits only the listed ids once set", () => {
		expect(isClientAllowed("client-a", "client-a")).toBe(true);
		expect(isClientAllowed("client-b", " client-a , client-b ")).toBe(true);
		expect(isClientAllowed("client-c", "client-a,client-b")).toBe(false);
	});

	// Client ids are random strings in mixed case, so a near match is another
	// client altogether.
	test("matches an id whole and case for case", () => {
		expect(isClientAllowed("Client-A", "client-a")).toBe(false);
		expect(isClientAllowed("client", "client-a")).toBe(false);
		expect(isClientAllowed("client-a-2", "client-a")).toBe(false);
		expect(isClientAllowed("", "client-a")).toBe(false);
	});
});

describe("isAutoPinEnabled", () => {
	// A deployment that never set the flag is pinned rather than open.
	test.each([
		["unset", undefined],
		["empty", ""],
		["true", "true"],
		["anything else", "yes please"],
	])("is on when PIN_FIRST_CLIENT is %s", (_name, flag) => {
		expect(isAutoPinEnabled(flag, undefined)).toBe(true);
	});

	test.each([["false"], ["FALSE"], ["0"], ["no"], [" off "]])("is off for %p", (flag) => {
		expect(isAutoPinEnabled(flag, undefined)).toBe(false);
	});

	test("gives way to an ALLOWED_CLIENT_IDS that names a client", () => {
		expect(isAutoPinEnabled("true", "client-a")).toBe(false);
		expect(isAutoPinEnabled("true", " , ")).toBe(true);
	});
});

describe("pinKey", () => {
	test("keys an account by its lowercased address, apart from the account markers", () => {
		expect(pinKey(" Owner@Example.com ")).toBe("pin:owner@example.com");
		expect(pinKey("owner@example.com").startsWith("account:")).toBe(false);
	});
});
