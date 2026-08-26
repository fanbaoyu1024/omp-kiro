import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { KiroCatalogModel } from "./shared.ts";
import { getKiroEndpoints } from "./shared.ts";

/**
 * Canonical streaming API id for the Kiro provider. Registering it replaces
 * the host's Kiro stream handler when this plugin is enabled.
 */
export const KIRO_API = "kiro-api" as const;

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

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;
const KIRO_RUNTIME = getKiroEndpoints("us-east-1").runtime;

/**
 * Standard OMP thinking metadata for Kiro reasoning models. `efforts` uses the
 * canonical low→max ladder; `mode` doubles as the cache-safe encoding of which
 * Kiro wire field carries the effort value:
 * - `"effort"` → `additionalModelRequestFields.reasoning.effort`
 * - `"budget"` → `additionalModelRequestFields.output_config.effort` (plus the
 *   adaptive thinking envelope Kiro expects alongside it)
 * See `buildAdditionalModelRequestFields` in stream.ts.
 */
const KIRO_THINKING = {
	mode: "effort",
	efforts: ["low", "medium", "high", "xhigh", "max"],
	defaultLevel: "high",
} as NonNullable<ProviderModelConfig["thinking"]>;

function isReasoningModel(id: string): boolean {
	return /auto|claude-opus|claude-sonnet|deepseek|gpt|glm|qwen/i.test(id);
}

function createBootstrapModel(
	id: string,
	options: Partial<
		Pick<
			KiroProviderModelConfig,
			"reasoning" | "input" | "contextWindow" | "maxTokens" | "thinking"
		>
	> = {},
): KiroProviderModelConfig {
	return {
		id,
		name: id
			.split("-")
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" "),
		api: KIRO_API,
		baseUrl: KIRO_RUNTIME,
		reasoning: options.reasoning ?? isReasoningModel(id),
		input:
			options.input ??
			(/^(auto|claude)/i.test(id) ? ["text", "image"] : ["text"]),
		cost: { ...ZERO_COST },
		contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(options.thinking ? { thinking: options.thinking } : {}),
	};
}

/**
 * Offline bootstrap matching the Kiro CLI 2.19.2 catalog. Once authenticated,
 * List-Available-Models is authoritative because availability is account and
 * profile scoped; omitted models must not be reintroduced from this list.
 */
export const KIRO_MODELS: readonly KiroProviderModelConfig[] = [
	createBootstrapModel("gpt-5.6-sol", {
		contextWindow: 272_000,
		input: ["text", "image"],
		thinking: KIRO_THINKING,
	}),
	createBootstrapModel("gpt-5.6-terra", {
		contextWindow: 272_000,
		input: ["text", "image"],
		thinking: KIRO_THINKING,
	}),
	createBootstrapModel("gpt-5.6-luna", {
		contextWindow: 272_000,
		input: ["text", "image"],
		thinking: KIRO_THINKING,
	}),
	createBootstrapModel("deepseek-3.2", {
		contextWindow: 164_000,
		input: ["text", "image"],
		thinking: KIRO_THINKING,
	}),
	createBootstrapModel("minimax-m2.5", {
		reasoning: false,
		contextWindow: 196_000,
	}),
	createBootstrapModel("minimax-m2.1", {
		reasoning: false,
		contextWindow: 196_000,
		input: ["text", "image"],
	}),
	createBootstrapModel("glm-5", {
		contextWindow: 200_000,
		thinking: KIRO_THINKING,
	}),
	createBootstrapModel("qwen3-coder-next", {
		contextWindow: 256_000,
		input: ["text", "image"],
		thinking: KIRO_THINKING,
	}),
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function effortEnumValues(
	schema: Record<string, unknown> | null | undefined,
	field: string,
): string[] {
	const properties = asRecord(asRecord(schema)?.properties);
	const fieldSchema = asRecord(properties?.[field]);
	const effortSchema = asRecord(asRecord(fieldSchema?.properties)?.effort);
	return Array.isArray(effortSchema?.enum)
		? effortSchema.enum.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
}

/**
 * Convert Kiro's opaque request-field schema into standard OMP thinking
 * metadata. The schema itself cannot survive the OMP model cache, so its one
 * relevant fact — which wire field carries the effort — is encoded in
 * `mode` for the stream layer to read back.
 */
function dynamicThinking(
	schema: Record<string, unknown> | null | undefined,
): NonNullable<ProviderModelConfig["thinking"]> | undefined {
	if (!schema) return undefined;
	const usesOutputConfig =
		effortEnumValues(schema, "output_config").length > 0 &&
		effortEnumValues(schema, "reasoning").length === 0;
	return { ...KIRO_THINKING, mode: usesOutputConfig ? "budget" : "effort" };
}

/**
 * Map a management catalog into OMP model configs. Every emitted fact lives on
 * a standard `ProviderModelConfig` field (plus `baseUrl`): no custom keys.
 */
export function mapKiroCatalogToProviderModelConfigs(
	catalog: readonly KiroCatalogModel[],
	region: string,
): KiroProviderModelConfig[] {
	const seen = new Set<string>();
	return catalog.map((model) => {
		const id = model.modelId.trim();
		if (!id || seen.has(id))
			throw new Error(
				`Kiro management catalog contains duplicate model ID ${id}`,
			);
		seen.add(id);
		const existing = KIRO_MODELS.find((candidate) => candidate.id === id);
		const limits = model.tokenLimits;
		const schema = model.additionalModelRequestFieldsSchema;
		return {
			...(existing ?? createBootstrapModel(id)),
			id,
			name:
				model.modelName?.trim() ||
				model.displayName?.trim() ||
				existing?.name ||
				id,
			api: KIRO_API,
			baseUrl: getKiroEndpoints(region).runtime,
			reasoning:
				schema !== undefined
					? true
					: (existing?.reasoning ?? isReasoningModel(id)),
			contextWindow:
				limits?.maxInputTokens ??
				existing?.contextWindow ??
				DEFAULT_CONTEXT_WINDOW,
			maxTokens:
				limits?.maxOutputTokens ?? existing?.maxTokens ?? DEFAULT_MAX_TOKENS,
			input:
				model.supportedInputTypes !== undefined
					? model.supportedInputTypes.some(
							(type) => type.toUpperCase() === "IMAGE",
						)
						? ["text", "image"]
						: ["text"]
					: (existing?.input ?? ["text"]),
			...(schema !== undefined ? { thinking: dynamicThinking(schema) } : {}),
		};
	});
}
