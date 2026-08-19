import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { KIRO_API, KIRO_MODELS } from "./catalog.ts";
import { kiroOAuth } from "./oauth.ts";
import { getKiroEndpoints } from "./shared.ts";
import { fetchKiroModelsForCredential, parseStructuredApiKey, streamKiro } from "./stream.ts";
import { kiroUsageProvider } from "./usage.ts";
/** Canonical provider id used to replace or extend the host Kiro provider. */
export const KIRO_PROVIDER_ID = "kiro" as const;

/**
 * Build the OMP `ProviderConfig` registered under `kiro`.
 *
 * Only `fetchDynamicModels` is configured — never `models`. The OMP registry
 * short-circuits `fetchDynamicModels` registration when `models` is non-empty,
 * so bootstrap and dynamic catalogs are mutually exclusive by construction.
 * The bootstrap/authenticated switch therefore lives inside `fetchDynamicModels`,
 * keyed on the resolved API key (undefined when unauthenticated).
 */
export function createKiroProviderConfig(): ProviderConfig {
	return {
		baseUrl: getKiroEndpoints("us-east-1").runtime,
		api: KIRO_API,
		oauth: {
			name: kiroOAuth.name,
			login: kiroOAuth.login,
			refreshToken: kiroOAuth.refreshToken,
			getApiKey: kiroOAuth.getApiKey,
		},
		streamSimple: streamKiro,
		usage: kiroUsageProvider,
		fetchDynamicModels: async (apiKey) => {
			const structured = parseStructuredApiKey(apiKey);
			if (!structured.token) {
				// Unauthenticated (or explicitly empty): return the offline
				// bootstrap catalog so the provider stays usable before /login.
				return KIRO_MODELS.map((model) => ({ ...model }));
			}
			return fetchKiroModelsForCredential({
				access: structured.token,
				region: structured.region,
				profileArn: structured.profileArn,
			});
		},
	};
}
