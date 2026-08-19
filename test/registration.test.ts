import { describe, expect, it, vi } from "bun:test";
import registerKiro from "../src/extension.ts";
import { createKiroProviderConfig, KIRO_PROVIDER_ID } from "../src/provider.ts";

describe("omp extension registration", () => {
	it("registers the kiro provider with a two-argument registerProvider call", () => {
		const registerProvider = vi.fn();
		registerKiro({ registerProvider } as never);

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
		expect(config.baseUrl).toContain("kiro.dev");
	});
});
