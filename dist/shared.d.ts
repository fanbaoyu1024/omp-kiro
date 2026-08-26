import type { FetchImpl } from "@oh-my-pi/pi-ai";
export interface KiroEndpoints {
    region: string;
    management: string;
    runtime: string;
}
export declare function resolveKiroApiRegion(ssoRegion?: string): string;
export declare function getKiroEndpoints(region: string): KiroEndpoints;
export declare function getKiroRegionFromEndpoint(endpoint: string | undefined): string | undefined;
export interface KiroManagementAuth {
    accessToken: string;
    region: string;
}
export interface KiroCatalogModel {
    modelId: string;
    displayName?: string;
    modelName?: string;
    supportedInputTypes?: string[];
    tokenLimits?: {
        maxInputTokens?: number;
        maxOutputTokens?: number;
        [key: string]: unknown;
    };
    additionalModelRequestFieldsSchema?: Record<string, unknown> | null;
    [key: string]: unknown;
}
export interface KiroListAvailableModelsResponse {
    models: KiroCatalogModel[];
    [key: string]: unknown;
}
export declare class KiroManagementHttpError extends Error {
    readonly status: number;
    constructor(operation: string, region: string, status: number);
}
/** @internal Shared by model-catalog and usage lookups; not part of the public plugin surface. */
export declare function managementRequest<TResponse>(auth: KiroManagementAuth, operation: string, path: string, method: "GET" | "POST", params: Record<string, string | undefined>, fetchFn: FetchImpl, signal?: AbortSignal): Promise<TResponse>;
export declare function resolveKiroProfileArn(auth: KiroManagementAuth, providedProfileArn: string | undefined, fetchFn?: FetchImpl, signal?: AbortSignal): Promise<string>;
export declare function fetchKiroModelCatalog(auth: KiroManagementAuth, providedProfileArn?: string, fetchFn?: FetchImpl, signal?: AbortSignal): Promise<{
    profileArn: string;
    response: KiroListAvailableModelsResponse;
}>;
//# sourceMappingURL=shared.d.ts.map