import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import {
	getKiroRegionFromEndpoint,
	KiroManagementHttpError,
	managementRequest,
	resolveKiroApiRegion,
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
	/** Epoch-millisecond reset timestamp, when the service returned a parseable date. */
	resetTimestampMs?: number;
	/** Parsed GetUsageLimits response body (never contains the request token). */
	raw?: KiroGetUsageLimitsResponse;
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

/**
 * Normalizes a reset value into an ISO calendar date and, when parseable, an
 * epoch-millisecond timestamp. Tolerates Unix seconds, milliseconds, and date
 * strings; unparseable strings are kept verbatim as the calendar date.
 */
function resolveReset(value: unknown): { nextReset?: string; resetTimestampMs?: number } {
	const numeric = toFiniteNumber(value);
	if (numeric !== undefined) {
		const timestampMs = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
		const date = new Date(timestampMs);
		return Number.isNaN(date.getTime())
			? {}
			: { nextReset: date.toISOString().slice(0, 10), resetTimestampMs: timestampMs };
	}
	const text = toOptionalString(value);
	if (!text) return {};
	const parsed = Date.parse(text);
	return Number.isFinite(parsed)
		? { nextReset: text, resetTimestampMs: parsed }
		: { nextReset: text };
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
	const reset = resolveReset(credit.nextDateReset);
	const fallbackReset = resolveReset(response.nextDateReset);
	return {
		usedCredits,
		totalCredits,
		remainingCredits: Math.max(totalCredits - usedCredits, 0),
		percentUsed: totalCredits > 0 ? (usedCredits / totalCredits) * 100 : 0,
		nextReset: reset.nextReset ?? fallbackReset.nextReset,
		subscriptionTitle: toOptionalString(response.subscriptionInfo?.subscriptionTitle),
		resetTimestampMs: reset.resetTimestampMs ?? fallbackReset.resetTimestampMs,
		raw: response,
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

const KIRO_PROVIDER = "kiro";

/** Extract the Identity Center region encoded in the refresh token tail (`<refresh>|<clientId>|<clientSecret>|idc|<region>`). */
function resolveRegionFromRefreshToken(refreshToken: string | undefined): string | undefined {
	if (!refreshToken) return undefined;
	const parts = refreshToken.split("|");
	return parts[3] === "idc" && parts[4] ? parts[4] : undefined;
}

/** Only OAuth credentials carrying an access token can back a Kiro usage report. */
function supportsKiroUsage(params: UsageFetchParams): boolean {
	return (
		params.provider === KIRO_PROVIDER &&
		params.credential.type === "oauth" &&
		!!params.credential.accessToken
	);
}

/** Standard quota status thresholds, mirroring the OMP usage display convention. */
function usageStatusFor(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

/**
 * Standard OMP usage fetcher for the Kiro credits quota. Reuses the
 * GetUsageLimits parsing behind {@link fetchKiroUsage} and resolves the
 * management region as: refresh token tail, then the base URL's Kiro region,
 * then `us-east-1`. The profile ARN is resolved through
 * {@link resolveKiroProfileArn} as usual.
 */
export async function fetchKiroUsageReport(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (!supportsKiroUsage(params)) return null;
	const credential = params.credential;
	const accessToken = credential.accessToken?.trim();
	if (!accessToken) return null;
	const region = resolveKiroApiRegion(
		resolveRegionFromRefreshToken(credential.refreshToken) ??
			getKiroRegionFromEndpoint(credential.apiEndpoint) ??
			getKiroRegionFromEndpoint(params.baseUrl),
	);

	let snapshot: KiroUsageSnapshot;
	try {
		snapshot = await fetchKiroUsage(
			{ accessToken, region },
			undefined,
			ctx.fetch,
			params.signal,
		);
	} catch (error) {
		if (error instanceof KiroManagementHttpError && (error.status === 401 || error.status === 403)) {
			throw new ProviderHttpError(
				`Kiro usage lookup rejected in ${region}: HTTP ${error.status}`,
				error.status,
			);
		}
		throw error;
	}

	const used = snapshot.usedCredits;
	const total = snapshot.totalCredits;
	const usedFraction = total > 0 ? used / total : undefined;
	const limit: UsageLimit = {
		id: "credits",
		label: "Credits",
		scope: {
			provider: KIRO_PROVIDER,
			...(snapshot.subscriptionTitle ? { tier: snapshot.subscriptionTitle } : {}),
			...(credential.accountId ? { accountId: credential.accountId } : {}),
			...(credential.projectId ? { projectId: credential.projectId } : {}),
			...(credential.orgId ? { orgId: credential.orgId } : {}),
		},
		window: {
			id: "billing-cycle",
			label: "Billing cycle",
			...(snapshot.resetTimestampMs !== undefined
				? { resetsAt: snapshot.resetTimestampMs }
				: {}),
		},
		amount: {
			used,
			limit: total,
			remaining: snapshot.remainingCredits,
			usedFraction,
			remainingFraction: total > 0 ? snapshot.remainingCredits / total : undefined,
			unit: "credits",
		},
		status: usageStatusFor(usedFraction),
	};
	return {
		provider: KIRO_PROVIDER,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: {
			region,
			...(credential.email ? { email: credential.email } : {}),
			...(credential.accountId ? { accountId: credential.accountId } : {}),
			...(credential.projectId ? { projectId: credential.projectId } : {}),
			...(credential.orgId ? { orgId: credential.orgId } : {}),
			...(snapshot.subscriptionTitle ? { subscriptionTitle: snapshot.subscriptionTitle } : {}),
		},
		...(snapshot.raw ? { raw: snapshot.raw } : {}),
	};
}

/**
 * Standard OMP usage provider registered under the plugin's `usage` config
 * field so the host `/usage` surfaces and `omp usage --provider kiro` report
 * the Kiro credits quota.
 */
export const kiroUsageProvider: UsageProvider = {
	id: KIRO_PROVIDER,
	supports: supportsKiroUsage,
	validatesCredentials: true,
	fetchUsage: fetchKiroUsageReport,
};
