import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
/** Canonical provider id used to replace or extend the host Kiro provider. */
export declare const KIRO_PROVIDER_ID: "kiro";
/**
 * Build the OMP `ProviderConfig` registered under `kiro`.
 *
 * Only `fetchDynamicModels` is configured — never `models`. The OMP registry
 * short-circuits `fetchDynamicModels` registration when `models` is non-empty,
 * so bootstrap and dynamic catalogs are mutually exclusive by construction.
 * The bootstrap/authenticated switch therefore lives inside `fetchDynamicModels`,
 * keyed on the resolved API key (undefined when unauthenticated).
 */
export declare function createKiroProviderConfig(): ProviderConfig;
//# sourceMappingURL=provider.d.ts.map