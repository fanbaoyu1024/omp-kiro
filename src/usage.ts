import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	managementRequest,
	resolveKiroProfileArn,
	type KiroManagementAuth,
} from "./shared.ts";

/** One entry of the `usageBreakdownList` array returned by GetUsageLimits. */
interface KiroUsageBreakdown {
	resourceType?: string;
	currentUsage?: number;
	usageLimit?: number;
	currentUsageWithPrecision?: number;
	usageLimitWithPrecision?: number;
	nextDateReset?: string | number;
	[key: string]: unknown;
}

/** Top-level shape of the GetUsageLimits response. */
interface KiroGetUsageLimitsResponse {
	usageBreakdownList?: KiroUsageBreakdown[];
	nextDateReset?: string | number;
	subscriptionInfo?: { subscriptionTitle?: string; [key: string]: unknown };
	[key: string]: unknown;
}

export interface KiroUsageSnapshot {
	usedCredits: number;
	totalCredits: number;
	remainingCredits: number;
	percentUsed: number;
	nextReset?: string;
	subscriptionTitle?: string;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toOptionalString(value: unknown): string | undefined {
	if (typeof value === "string") return value.length > 0 ? value : undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function normalizeResetDate(value: unknown): string | undefined {
	const numeric = toFiniteNumber(value);
	if (numeric !== undefined) {
		const date = new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
		if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
	}
	return toOptionalString(value);
}

export async function fetchKiroUsage(
	auth: KiroManagementAuth,
	providedProfileArn?: string,
	fetchFn: FetchImpl = globalThis.fetch,
	signal?: AbortSignal,
): Promise<KiroUsageSnapshot> {
	const profileArn = await resolveKiroProfileArn(auth, providedProfileArn, fetchFn, signal);
	const response = await managementRequest<KiroGetUsageLimitsResponse>(
		auth,
		"GetUsageLimits",
		"getUsageLimits",
		"GET",
		{ origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST", profileArn },
		fetchFn,
		signal,
	);
	const credit = response.usageBreakdownList?.find(
		(item) => item?.resourceType === "CREDIT",
	);
	if (!credit) {
		throw new Error(`Kiro management GetUsageLimits returned no credit breakdown in ${auth.region}`);
	}
	const usedCredits =
		toFiniteNumber(credit.currentUsageWithPrecision) ??
		toFiniteNumber(credit.currentUsage);
	const totalCredits =
		toFiniteNumber(credit.usageLimitWithPrecision) ??
		toFiniteNumber(credit.usageLimit);
	if (usedCredits === undefined || totalCredits === undefined) {
		throw new Error(`Kiro management GetUsageLimits returned an invalid credit breakdown in ${auth.region}`);
	}
	return {
		usedCredits,
		totalCredits,
		remainingCredits: Math.max(totalCredits - usedCredits, 0),
		percentUsed: totalCredits > 0 ? (usedCredits / totalCredits) * 100 : 0,
		nextReset:
			normalizeResetDate(credit.nextDateReset) ??
			normalizeResetDate(response.nextDateReset),
		subscriptionTitle: toOptionalString(response.subscriptionInfo?.subscriptionTitle),
	};
}

/** Renders at most two decimal places and strips integer tails (e.g. `327.46`, `1000`). */
function formatCredits(value: number): string {
	return String(Math.round(value * 100) / 100);
}

export function formatKiroUsage(snapshot: KiroUsageSnapshot): string {
	const lines = [
		snapshot.subscriptionTitle ?? "Kiro credits",
		`Used ${formatCredits(snapshot.usedCredits)} of ${formatCredits(snapshot.totalCredits)} credits (${formatCredits(snapshot.percentUsed)}%)`,
		`Remaining ${formatCredits(snapshot.remainingCredits)} credits`,
	];
	if (snapshot.nextReset) lines.push(`Resets ${snapshot.nextReset}`);
	return lines.join("\n");
}
