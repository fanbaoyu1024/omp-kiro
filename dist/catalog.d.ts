import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { KiroCatalogModel } from "./shared.ts";
/**
 * Canonical streaming API id for the Kiro provider. Registering it replaces
 * the host's Kiro stream handler when this plugin is enabled.
 */
export declare const KIRO_API: "kiro-api";
/**
 * A Kiro model as an OMP `ProviderModelConfig` plus a region-scoped base URL.
 *
 * OMP's runtime registry reads `baseUrl` from each dynamically-fetched model
 * definition (`modelDef.baseUrl ?? providerBaseUrl`) and persists it on the
 * standard `ModelSpec.baseUrl` field, so the per-model region survives the
 * SQLite model cache. Arbitrary custom fields would NOT survive, so every
 * region/profile/schema fact must be expressed through standard fields only:
 * - model id: the Kiro API model id verbatim
 * - region: `baseUrl` (recovered via `getKiroRegionFromEndpoint`)
 * - profile ARN: the `x-amzn-kiro-profile-arn` header (wire-correct and cached)
 * - thinking surface: the standard `thinking` metadata (mode encodes the wire
 *   field Kiro expects for effort values)
 */
export type KiroProviderModelConfig = ProviderModelConfig & {
    baseUrl: string;
};
/**
 * Offline bootstrap matching the Kiro CLI 2.19.2 catalog. Once authenticated,
 * List-Available-Models is authoritative because availability is account and
 * profile scoped; omitted models must not be reintroduced from this list.
 */
export declare const KIRO_MODELS: readonly KiroProviderModelConfig[];
/**
 * Map a management catalog into OMP model configs. Every emitted fact lives on
 * a standard `ProviderModelConfig` field (plus `baseUrl`): no custom keys.
 */
export declare function mapKiroCatalogToProviderModelConfigs(catalog: readonly KiroCatalogModel[], region: string): KiroProviderModelConfig[];
//# sourceMappingURL=catalog.d.ts.map