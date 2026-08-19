import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createKiroProviderConfig, KIRO_PROVIDER_ID } from "./provider.ts";

export default function registerKiro(pi: ExtensionAPI): void {
	pi.registerProvider(KIRO_PROVIDER_ID, createKiroProviderConfig());
}

export { createKiroProviderConfig, KIRO_PROVIDER_ID } from "./provider.ts";
