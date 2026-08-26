import { describe, expect, it, vi } from "bun:test";
import registerKiro, {
	handleKiroUsageCommand,
	KIRO_USAGE_COMMAND,
	setKiroMeteringStatus,
} from "../src/extension.ts";
import { createKiroProviderConfig, KIRO_PROVIDER_ID } from "../src/provider.ts";
import { recordKiroMetering } from "../src/stream.ts";
import { kiroUsageProvider } from "../src/usage.ts";

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

	it("accumulates native credits per session", () => {
		const on = vi.fn();
		registerKiro({
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
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
	});
});
