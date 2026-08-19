import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
export interface KiroOAuthCredential extends OAuthCredentials {
    clientId: string;
    clientSecret: string;
    region: string;
    authMethod: "idc";
    profileArn?: string;
}
declare function loginKiro(callbacks: OAuthLoginCallbacks): Promise<KiroOAuthCredential>;
declare function refreshKiroToken(credential: OAuthCredentials): Promise<KiroOAuthCredential>;
/**
 * Structured API key consumed by `fetchDynamicModels` and `streamKiro`: the
 * bearer token plus the credential's Identity Center region and resolved
 * profile ARN (when known).
 */
export declare function getKiroApiKey(credential: OAuthCredentials): string;
export declare const kiroOAuth: {
    name: string;
    login: typeof loginKiro;
    refreshToken: typeof refreshKiroToken;
    getApiKey: typeof getKiroApiKey;
};
export {};
//# sourceMappingURL=oauth.d.ts.map