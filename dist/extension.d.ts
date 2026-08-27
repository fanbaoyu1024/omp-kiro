import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
/** Slash command that reports the current Kiro credits usage. */
export declare const KIRO_USAGE_COMMAND: "kiro-usage";
/**
 * Custom session entry type persisting one metered Kiro credit charge per
 * message. Entries are appended on `message_end` and re-aggregated on
 * `session_start` so accumulated credits survive OMP restarts, session
 * resumes, and branch switches.
 */
export declare const KIRO_CREDIT_ENTRY_TYPE: "kiro-credit-metering";
/** Shape of the data persisted with {@link KIRO_CREDIT_ENTRY_TYPE} entries. */
export interface KiroCreditEntryData {
    credits: number;
    unit: "credit";
}
export declare function setKiroMeteringStatus(ui: ExtensionUIContext, text: string | undefined): void;
/** Handler for /kiro-usage: fetches and displays the Kiro credits snapshot. */
export declare function handleKiroUsageCommand(_args: string, ctx: ExtensionCommandContext): Promise<void>;
export default function registerKiro(pi: ExtensionAPI): void;
export { createKiroProviderConfig, KIRO_PROVIDER_ID } from "./provider.ts";
export { kiroUsageProvider } from "./usage.ts";
//# sourceMappingURL=extension.d.ts.map