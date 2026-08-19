import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
/** Slash command that reports the current Kiro credits usage. */
export declare const KIRO_USAGE_COMMAND: "kiro-usage";
/** Handler for /kiro-usage: fetches and displays the Kiro credits snapshot. */
export declare function handleKiroUsageCommand(_args: string, ctx: ExtensionCommandContext): Promise<void>;
export default function registerKiro(pi: ExtensionAPI): void;
export { createKiroProviderConfig, KIRO_PROVIDER_ID } from "./provider.ts";
export { kiroUsageProvider } from "./usage.ts";
//# sourceMappingURL=extension.d.ts.map