import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { createKiroProviderConfig, KIRO_PROVIDER_ID } from "./provider.ts";
import { resolveKiroApiRegion } from "./shared.ts";
import {
	consumeKiroMetering,
	parseStructuredApiKey,
	type StructuredKiroApiKey,
} from "./stream.ts";
import { fetchKiroUsage, formatKiroUsage } from "./usage.ts";

/** Slash command that reports the current Kiro credits usage. */
export const KIRO_USAGE_COMMAND = "kiro-usage" as const;

/**
 * Custom session entry type persisting one metered Kiro credit charge per
 * message. Entries are appended on `message_end` and re-aggregated on
 * `session_start` so accumulated credits survive OMP restarts, session
 * resumes, and branch switches.
 */
export const KIRO_CREDIT_ENTRY_TYPE = "kiro-credit-metering" as const;

/** Shape of the data persisted with {@link KIRO_CREDIT_ENTRY_TYPE} entries. */
export interface KiroCreditEntryData {
	credits: number;
	unit: "credit";
}

/**
 * Structural view of a session entry sufficient for credit aggregation.
 * Mirrors the host's custom entry (`type: "custom"` + `customType`).
 */
interface CreditMeteringEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** True when an entry carries a usable, finite, non-negative credit charge. */
function isCreditMeteringEntry(
	entry: CreditMeteringEntry,
): entry is CreditMeteringEntry & { data: KiroCreditEntryData } {
	if (
		entry.type !== "custom" ||
		entry.customType !== KIRO_CREDIT_ENTRY_TYPE
	) {
		return false;
	}
	const data = entry.data;
	if (!data || typeof data !== "object") return false;
	const record = data as Record<string, unknown>;
	return (
		typeof record.credits === "number" &&
		Number.isFinite(record.credits) &&
		record.credits >= 0 &&
		record.unit === "credit"
	);
}

/**
 * Sum the valid credit charges on the given entry path (the current branch,
 * as returned by `sessionManager.getBranch()`). Malformed or foreign entries
 * are skipped.
 */
function sumBranchCredits(entries: readonly CreditMeteringEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (isCreditMeteringEntry(entry)) total += entry.data.credits;
	}
	return total;
}

/** Remove the structured credential values from a message before surfacing it. */
function redactKiroCredentials(
	message: string,
	structured: StructuredKiroApiKey | undefined,
): string {
	if (!structured) return message;
	const redacted = message.split(structured.token).join("[redacted]");
	return structured.profileArn
		? redacted.split(structured.profileArn).join("[redacted]")
		: redacted;
}

function formatMeteredCredits(value: number): string {
	const precision = value < 0.01 ? 6 : 3;
	return value.toFixed(precision).replace(/\.?0+$/, "");
}

export function setKiroMeteringStatus(
	ui: ExtensionUIContext,
	text: string | undefined,
): void {
	if (
		"setStatusLine" in ui &&
		typeof ui.setStatusLine === "function"
	) {
		ui.setStatusLine("kiro-credits", text);
		ui.setStatus("kiro-credits", undefined);
		return;
	}
	ui.setStatus("kiro-credits", text);
}

/** Handler for /kiro-usage: fetches and displays the Kiro credits snapshot. */
export async function handleKiroUsageCommand(
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let structured: StructuredKiroApiKey | undefined;
	try {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(KIRO_PROVIDER_ID);
		structured = parseStructuredApiKey(apiKey);
		if (!structured.token) {
			ctx.ui.notify("Kiro credentials not set. Run /login kiro first.", "error");
			return;
		}
		const snapshot = await fetchKiroUsage(
			{
				accessToken: structured.token,
				region: resolveKiroApiRegion(structured.region),
			},
			structured.profileArn,
		);
		ctx.ui.notify(formatKiroUsage(snapshot), "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(
			`Kiro usage lookup failed: ${redactKiroCredentials(message, structured)}`,
			"error",
		);
	}
}

export default function registerKiro(pi: ExtensionAPI): void {
	pi.registerProvider(KIRO_PROVIDER_ID, createKiroProviderConfig());
	pi.registerCommand(KIRO_USAGE_COMMAND, {
		description: "Show Kiro credits usage and next reset date",
		handler: handleKiroUsageCommand,
	});
	const creditsBySession = new Map<string, number>();
	pi.on("session_start", (_event, ctx) => {
		// Rebuild the in-memory total from the persisted entries on the
		// current branch: a fresh extension instance (OMP restart, session
		// resume) restores accumulated credits, and a rewound branch only
		// counts its own path. Rebuilding is idempotent, so repeated
		// session_start events never double-count.
		const sessionId = ctx.sessionManager.getSessionId();
		const total = sumBranchCredits(ctx.sessionManager.getBranch());
		creditsBySession.set(sessionId, total);
		setKiroMeteringStatus(
			ctx.ui,
			total > 0
				? `Kiro Σ ${formatMeteredCredits(total)} credits`
				: undefined,
		);
	});
	pi.on("message_end", (event, ctx) => {
		if (
			event.message.role !== "assistant" ||
			event.message.provider !== KIRO_PROVIDER_ID
		) {
			return;
		}
		const metering = consumeKiroMetering(event.message.timestamp);
		if (!metering || metering.unit.toLowerCase() !== "credit") return;
		if (!Number.isFinite(metering.value) || metering.value < 0) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const total = (creditsBySession.get(sessionId) ?? 0) + metering.value;
		creditsBySession.set(sessionId, total);
		// Persist the charge so a later session_start can restore the total.
		pi.appendEntry(KIRO_CREDIT_ENTRY_TYPE, {
			credits: metering.value,
			unit: "credit",
		} satisfies KiroCreditEntryData);
		setKiroMeteringStatus(
			ctx.ui,
			`Kiro ${formatMeteredCredits(metering.value)} credits · Σ ${formatMeteredCredits(total)}`,
		);
	});
}

export { createKiroProviderConfig, KIRO_PROVIDER_ID } from "./provider.ts";
export { kiroUsageProvider } from "./usage.ts";
