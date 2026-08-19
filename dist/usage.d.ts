import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { type KiroManagementAuth } from "./shared.ts";
export interface KiroUsageSnapshot {
    usedCredits: number;
    totalCredits: number;
    remainingCredits: number;
    percentUsed: number;
    nextReset?: string;
    subscriptionTitle?: string;
}
export declare function fetchKiroUsage(auth: KiroManagementAuth, providedProfileArn?: string, fetchFn?: FetchImpl, signal?: AbortSignal): Promise<KiroUsageSnapshot>;
export declare function formatKiroUsage(snapshot: KiroUsageSnapshot): string;
//# sourceMappingURL=usage.d.ts.map