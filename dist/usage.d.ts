import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { type KiroManagementAuth } from "./shared.ts";
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
    subscriptionInfo?: {
        subscriptionTitle?: string;
        [key: string]: unknown;
    };
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
export declare function fetchKiroUsage(auth: KiroManagementAuth, providedProfileArn?: string, fetchFn?: FetchImpl, signal?: AbortSignal): Promise<KiroUsageSnapshot>;
export declare function formatKiroUsage(snapshot: KiroUsageSnapshot): string;
/** Compatibility shape for OMP releases before `credits` joined UsageUnit. */
export type KiroCreditLimit = Omit<UsageLimit, "amount"> & {
    amount: Omit<UsageLimit["amount"], "unit"> & {
        unit: "credits";
    };
};
export interface KiroUsageReport extends Omit<UsageReport, "limits"> {
    limits: KiroCreditLimit[];
}
/** Structural equivalent of the extension UsageProvider contract added upstream. */
export interface KiroUsageProvider {
    id: string;
    fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<KiroUsageReport | null>;
    supports?(params: UsageFetchParams): boolean;
    validatesCredentials?: boolean;
}
/**
 * Standard OMP usage fetcher for the Kiro credits quota. Reuses the
 * GetUsageLimits parsing behind {@link fetchKiroUsage} and resolves the
 * management region as: refresh token tail, then the base URL's Kiro region,
 * then `us-east-1`. The profile ARN is resolved through
 * {@link resolveKiroProfileArn} as usual.
 */
export declare function fetchKiroUsageReport(params: UsageFetchParams, ctx: UsageFetchContext): Promise<KiroUsageReport | null>;
/**
 * Standard OMP usage provider registered under the plugin's `usage` config
 * field so the host `/usage` surfaces and `omp usage --provider kiro` report
 * the Kiro credits quota.
 */
export declare const kiroUsageProvider: KiroUsageProvider;
export {};
//# sourceMappingURL=usage.d.ts.map