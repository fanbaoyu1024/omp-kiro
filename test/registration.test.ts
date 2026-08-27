import { describe, expect, it, vi, type Mock } from "bun:test";
import registerKiro, {
	handleKiroUsageCommand,
	KIRO_CREDIT_ENTRY_TYPE,
	KIRO_USAGE_COMMAND,
	setKiroMeteringStatus,
} from "../src/extension.ts";
import { createKiroProviderConfig, KIRO_PROVIDER_ID } from "../src/provider.ts";
import { recordKiroMetering } from "../src/stream.ts";
import { kiroUsageProvider } from "../src/usage.ts";

/** A persisted credit charge as the host would return it from getBranch(). */
function creditEntry(credits: number, unit: string = "credit") {
	return {
		type: "custom",
		customType: KIRO_CREDIT_ENTRY_TYPE,
		data: { credits, unit },
	};
}

/** The message_end handler registered by the extension. */
function endHandler(
	on: Mock,
): (
	event: {
		message: { role: string; provider: string; timestamp: number };
	},
	ctx: {
		sessionManager: { getSessionId(): string };
		ui: {
			setStatus(key: string, text: string | undefined): void;
			setStatusLine(key: string, text: string | undefined): void;
		};
	},
) => void {
	return on.mock.calls.find(([name]) => name === "message_end")?.[1] as (
		event: {
			message: { role: string; provider: string; timestamp: number };
		},
		ctx: {
			sessionManager: { getSessionId(): string };
			ui: {
				setStatus(key: string, text: string | undefined): void;
				setStatusLine(key: string, text: string | undefined): void;
			};
		},
	) => void;
}

/** The session_start handler registered by the extension. */
function startHandler(on: Mock) {
	return on.mock.calls.find(([name]) => name === "session_start")?.[1] as (
		event: unknown,
		ctx: {
			sessionManager: {
				getSessionId(): string;
				getBranch(): unknown[];
			};
			ui: {
				setStatus(key: string, text: string | undefined): void;
				setStatusLine(key: string, text: string | undefined): void;
			};
		},
	) => void;
}

describe("omp extension registration", () => {
	it("registers the kiro provider with a two-argument registerProvider call", () => {
		const registerProvider = vi.fn();
		const registerCommand = vi.fn();
		const on = vi.fn();
		registerKiro({ registerProvider, registerCommand, on } as never);

		expect(registerProvider).toHaveBeenCalledTimes(1);
		const [name, config] = registerProvider.mock.calls[0] as [
			string,
			...unknown[],
		];
		const providerConfig = config as {
			api?: string;
			baseUrl?: string;
			models?: unknown;
			oauth?: {
				name?: string;
				login?: unknown;
				refreshToken?: unknown;
				getApiKey?: unknown;
			};
			streamSimple?: unknown;
			fetchDynamicModels?: unknown;
			usage?: unknown;
		};
		expect(name).toBe("kiro");
		expect(providerConfig.api).toBe("kiro-api");
		expect(providerConfig.baseUrl).toBe("https://runtime.us-east-1.kiro.dev/");
		expect(providerConfig.oauth?.name).toBe("Kiro (AWS Builder ID / IAM Identity Center plugin)");
		expect(typeof providerConfig.oauth?.login).toBe("function");
		expect(typeof providerConfig.oauth?.refreshToken).toBe("function");
		expect(typeof providerConfig.oauth?.getApiKey).toBe("function");
		expect(typeof providerConfig.streamSimple).toBe("function");
		expect(typeof providerConfig.fetchDynamicModels).toBe("function");
		expect(providerConfig.usage).toBe(kiroUsageProvider);
		// Bootstrap and dynamic catalogs are mutually exclusive in the OMP
		// registry: a non-empty `models` short-circuits fetchDynamicModels.
		// The bootstrap/authenticated switch must live inside fetchDynamicModels.
		expect(providerConfig.models).toBeUndefined();
	});

	it("exposes a config factory with the provider surface constants", () => {
		const config = createKiroProviderConfig();
		expect(KIRO_PROVIDER_ID).toBe("kiro");
		expect(config.api).toBe("kiro-api");
		expect(config.models).toBeUndefined();
		expect(config.oauth?.name).toBe("Kiro (AWS Builder ID / IAM Identity Center plugin)");
		expect(config.usage).toBe(kiroUsageProvider);
		expect(config.baseUrl).toContain("kiro.dev");
	});
});

describe("kiro-usage command", () => {
	it("registers the kiro-usage command exactly once with a description and callable handler", () => {
		const registerProvider = vi.fn();
		const registerCommand = vi.fn();
		const on = vi.fn();
		registerKiro({ registerProvider, registerCommand, on } as never);

		expect(registerProvider).toHaveBeenCalledTimes(1);
		expect(registerCommand).toHaveBeenCalledTimes(1);
		expect(on).toHaveBeenCalledWith("message_end", expect.any(Function));
		const [name, options] = registerCommand.mock.calls[0] as [
			string,
			{ description?: string; handler?: unknown },
		];
		expect(name).toBe("kiro-usage");
		expect(KIRO_USAGE_COMMAND).toBe("kiro-usage");
		expect(typeof options.description).toBe("string");
		expect((options.description as string).length).toBeGreaterThan(0);
		expect(options.handler).toBe(handleKiroUsageCommand);
	});

	it("prompts for /login kiro via an error notification when no credential is stored", async () => {
		const getApiKeyForProvider = vi.fn().mockResolvedValue(undefined);
		const notify = vi.fn();
		const ctx = {
			modelRegistry: { getApiKeyForProvider },
			ui: { notify },
		} as never;

		await handleKiroUsageCommand("", ctx);

		expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
		expect(getApiKeyForProvider).toHaveBeenCalledWith("kiro");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toBe(
			"Kiro credentials not set. Run /login kiro first.",
		);
		expect(notify.mock.calls[0][1]).toBe("error");
	});
});

describe("Kiro metering status placement", () => {
	it("uses the inline status-line API when the host supports it", () => {
		const setStatus = vi.fn();
		const setStatusLine = vi.fn();

		setKiroMeteringStatus(
			{ setStatus, setStatusLine } as never,
			"Kiro 0.006 credits",
		);

		expect(setStatusLine).toHaveBeenCalledWith(
			"kiro-credits",
			"Kiro 0.006 credits",
		);
		expect(setStatus).toHaveBeenCalledWith("kiro-credits", undefined);
	});

	it("falls back to the legacy hook-status row on older hosts", () => {
		const setStatus = vi.fn();

		setKiroMeteringStatus({ setStatus } as never, "Kiro 0.006 credits");

		expect(setStatus).toHaveBeenCalledWith(
			"kiro-credits",
			"Kiro 0.006 credits",
		);
	});

	it("accumulates native credits per session and persists each charge once", () => {
		const on = vi.fn();
		const appendEntry = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry,
			on,
		} as never);
		const handler = on.mock.calls.find(
			([event]) => event === "message_end",
		)?.[1] as (
			event: {
				message: {
					role: "assistant";
					provider: "kiro";
					timestamp: number;
				};
			},
			ctx: {
				sessionManager: { getSessionId(): string };
				ui: {
					setStatus(key: string, text: string | undefined): void;
					setStatusLine(key: string, text: string | undefined): void;
				};
			},
		) => void;
		const setStatus = vi.fn();
		const setStatusLine = vi.fn();
		const ctx = {
			sessionManager: { getSessionId: () => "session-fixture" },
			ui: { setStatus, setStatusLine },
		};

		recordKiroMetering(101, {
			value: 0.1,
			unit: "credit",
			unitPlural: "credits",
		});
		handler(
			{ message: { role: "assistant", provider: "kiro", timestamp: 101 } },
			ctx,
		);
		recordKiroMetering(102, {
			value: 0.2,
			unit: "credit",
			unitPlural: "credits",
		});
		handler(
			{ message: { role: "assistant", provider: "kiro", timestamp: 102 } },
			ctx,
		);

		expect(setStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro 0.2 credits · Σ 0.3",
		);
		expect(appendEntry).toHaveBeenCalledTimes(2);
		expect(appendEntry).toHaveBeenNthCalledWith(
			1,
			KIRO_CREDIT_ENTRY_TYPE,
			{ credits: 0.1, unit: "credit" },
		);
		expect(appendEntry).toHaveBeenNthCalledWith(
			2,
			KIRO_CREDIT_ENTRY_TYPE,
			{ credits: 0.2, unit: "credit" },
		);
	});

	it("clears the metering status when the resumed branch has no charges", () => {
		const on = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry: vi.fn(),
			on,
		} as never);
		const setStatus = vi.fn();
		const setStatusLine = vi.fn();

		startHandler(on)(
			{ type: "session_start" },
			{
				sessionManager: {
					getSessionId: () => "empty-session",
					getBranch: () => [],
				},
				ui: { setStatus, setStatusLine },
			},
		);

		expect(setStatusLine).toHaveBeenCalledWith(
			"kiro-credits",
			undefined,
		);
		expect(setStatus).toHaveBeenCalledWith("kiro-credits", undefined);
	});

	it("restores the accumulated total from persisted entries on session_start", () => {
		// First extension instance meters two messages and persists each charge.
		const persisted: Array<{
			type: string;
			customType: string;
			data: { credits: number; unit: string };
		}> = [];
		const firstOn = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry: (_type: string, data: { credits: number; unit: string }) => {
				persisted.push({
					type: "custom",
					customType: KIRO_CREDIT_ENTRY_TYPE,
					data,
				});
			},
			on: firstOn,
		} as never);
		const firstEnd = endHandler(firstOn);
		const firstUi = { setStatus: vi.fn(), setStatusLine: vi.fn() };
		const firstCtx = {
			sessionManager: { getSessionId: () => "session-resume" },
			ui: firstUi,
		};
		recordKiroMetering(301, {
			value: 0.1,
			unit: "credit",
			unitPlural: "credits",
		});
		firstEnd(
			{ message: { role: "assistant", provider: "kiro", timestamp: 301 } },
			firstCtx,
		);
		recordKiroMetering(302, {
			value: 0.2,
			unit: "credit",
			unitPlural: "credits",
		});
		firstEnd(
			{ message: { role: "assistant", provider: "kiro", timestamp: 302 } },
			firstCtx,
		);
		expect(persisted).toHaveLength(2);

		// A fresh extension instance (OMP restart / session resume) rebuilds
		// the total from the persisted branch on session_start.
		const resumedOn = vi.fn();
		const resumedAppend = vi.fn();
		const resumedSetStatus = vi.fn();
		const resumedSetStatusLine = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry: resumedAppend,
			on: resumedOn,
		} as never);
		startHandler(resumedOn)(
			{ type: "session_start" },
			{
				sessionManager: {
					getSessionId: () => "session-resume",
					getBranch: () => persisted,
				},
				ui: {
					setStatus: resumedSetStatus,
					setStatusLine: resumedSetStatusLine,
				},
			},
		);
		expect(resumedSetStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro Σ 0.3 credits",
		);

		// Metering continues on top of the restored total, appending once.
		recordKiroMetering(303, {
			value: 0.4,
			unit: "credit",
			unitPlural: "credits",
		});
		endHandler(resumedOn)(
			{ message: { role: "assistant", provider: "kiro", timestamp: 303 } },
			{
				sessionManager: { getSessionId: () => "session-resume" },
				ui: {
					setStatus: resumedSetStatus,
					setStatusLine: resumedSetStatusLine,
				},
			},
		);
		expect(resumedSetStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro 0.4 credits · Σ 0.7",
		);
		expect(resumedAppend).toHaveBeenCalledTimes(1);
	});

	it("session_start aggregates only the current branch path", () => {
		const on = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry: vi.fn(),
			on,
		} as never);
		const setStatus = vi.fn();
		const setStatusLine = vi.fn();
		const getEntries = vi.fn();
		startHandler(on)(
			{ type: "session_start" },
			{
				sessionManager: {
					getSessionId: () => "session-branch",
					// Current leaf path only: the 0.5 charge sits on an
					// abandoned branch and must never be counted.
					getBranch: () => [creditEntry(0.1), creditEntry(0.2)],
					getEntries,
				},
				ui: { setStatus, setStatusLine },
			},
		);
		expect(getEntries).not.toHaveBeenCalled();
		expect(setStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro Σ 0.3 credits",
		);

		// New charges continue from the branch-restored total, not the
		// abandoned branch's 0.5.
		recordKiroMetering(401, {
			value: 0.4,
			unit: "credit",
			unitPlural: "credits",
		});
		endHandler(on)(
			{ message: { role: "assistant", provider: "kiro", timestamp: 401 } },
			{
				sessionManager: { getSessionId: () => "session-branch" },
				ui: { setStatus, setStatusLine },
			},
		);
		expect(setStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro 0.4 credits · Σ 0.7",
		);
	});

	it("session_start ignores malformed credit entries", () => {
		const on = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry: vi.fn(),
			on,
		} as never);
		const setStatus = vi.fn();
		const setStatusLine = vi.fn();
		startHandler(on)(
			{ type: "session_start" },
			{
				sessionManager: {
					getSessionId: () => "session-malformed",
					getBranch: () => [
						{
							type: "custom",
							customType: KIRO_CREDIT_ENTRY_TYPE,
							data: { credits: "0.1", unit: "credit" },
						},
						{
							type: "custom",
							customType: KIRO_CREDIT_ENTRY_TYPE,
							data: { credits: -0.5, unit: "credit" },
						},
						{
							type: "custom",
							customType: KIRO_CREDIT_ENTRY_TYPE,
							data: { credits: Number.NaN, unit: "credit" },
						},
						{
							type: "custom",
							customType: KIRO_CREDIT_ENTRY_TYPE,
							data: {
								credits: Number.POSITIVE_INFINITY,
								unit: "credit",
							},
						},
						{
							type: "custom",
							customType: KIRO_CREDIT_ENTRY_TYPE,
							data: { credits: 0.3, unit: "tokens" },
						},
						{ type: "custom", customType: KIRO_CREDIT_ENTRY_TYPE },
						{
							type: "custom",
							customType: "some-other-type",
							data: { credits: 9, unit: "credit" },
						},
						{ type: "message" },
						creditEntry(0.2),
						creditEntry(0.1),
					],
				},
				ui: { setStatus, setStatusLine },
			},
		);
		expect(setStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro Σ 0.3 credits",
		);
	});

	it("keeps per-session totals isolated", () => {
		const on = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry: vi.fn(),
			on,
		} as never);
		const end = endHandler(on);
		const uiA = { setStatus: vi.fn(), setStatusLine: vi.fn() };
		const uiB = { setStatus: vi.fn(), setStatusLine: vi.fn() };
		const ctxA = {
			sessionManager: { getSessionId: () => "session-a" },
			ui: uiA,
		};
		const ctxB = {
			sessionManager: { getSessionId: () => "session-b" },
			ui: uiB,
		};

		recordKiroMetering(501, {
			value: 0.1,
			unit: "credit",
			unitPlural: "credits",
		});
		end(
			{ message: { role: "assistant", provider: "kiro", timestamp: 501 } },
			ctxA,
		);
		recordKiroMetering(502, {
			value: 0.5,
			unit: "credit",
			unitPlural: "credits",
		});
		end(
			{ message: { role: "assistant", provider: "kiro", timestamp: 502 } },
			ctxB,
		);
		recordKiroMetering(503, {
			value: 0.2,
			unit: "credit",
			unitPlural: "credits",
		});
		end(
			{ message: { role: "assistant", provider: "kiro", timestamp: 503 } },
			ctxA,
		);

		expect(uiA.setStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro 0.2 credits · Σ 0.3",
		);
		expect(uiB.setStatusLine).toHaveBeenLastCalledWith(
			"kiro-credits",
			"Kiro 0.5 credits · Σ 0.5",
		);
	});
});
