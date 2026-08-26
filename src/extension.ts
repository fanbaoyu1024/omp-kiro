import type {
	ExtensionAPI,
	ExtensionCommandContext,
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
	pi.on("message_end", (event, ctx) => {
		if (
			event.message.role !== "assistant" ||
			event.message.provider !== KIRO_PROVIDER_ID
		) {
			return;
		}
		const metering = consumeKiroMetering(event.message.timestamp);
		if (!metering || metering.unit.toLowerCase() !== "credit") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const total = (creditsBySession.get(sessionId) ?? 0) + metering.value;
		creditsBySession.set(sessionId, total);
		ctx.ui.setStatus(
			"kiro-credits",
			`Kiro ${formatMeteredCredits(metering.value)} credits · Σ ${formatMeteredCredits(total)}`,
		);
	});
}

export { createKiroProviderConfig, KIRO_PROVIDER_ID } from "./provider.ts";
export { kiroUsageProvider } from "./usage.ts";
