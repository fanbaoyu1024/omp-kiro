import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, StreamOptions } from "@oh-my-pi/pi-ai";
import { type KiroProviderModelConfig } from "./catalog.ts";
export interface KiroUserInputMessage {
    content: string;
    modelId: string;
    origin: "KIRO_CLI";
    images?: Array<{
        format: string;
        source: {
            bytes: string;
        };
    }>;
    userInputMessageContext?: {
        toolResults?: Array<{
            content: Array<{
                text: string;
            }>;
            status: "success" | "error";
            toolUseId: string;
        }>;
        tools?: Array<{
            toolSpecification: {
                name: string;
                description: string;
                inputSchema: {
                    json: Record<string, unknown>;
                };
            };
        }>;
    };
}
export interface KiroHistoryEntry {
    userInputMessage?: KiroUserInputMessage;
    assistantResponseMessage?: {
        content: string;
        toolUses?: Array<{
            name: string;
            toolUseId: string;
            input: Record<string, unknown>;
        }>;
    };
}
export interface KiroRequest {
    profileArn: string;
    conversationState: {
        chatTriggerType: "MANUAL";
        agentTaskType: "vibe";
        conversationId: string;
        history?: KiroHistoryEntry[];
        currentMessage: {
            userInputMessage: KiroUserInputMessage;
        };
    };
    additionalModelRequestFields?: Record<string, unknown>;
    agentMode: "vibe";
}
type KiroEvent = {
    type: "content";
    data: string;
} | {
    type: "thinkingText";
    data: string;
} | {
    type: "thinkingSignature";
    data: string;
} | {
    type: "toolUse";
    data: {
        name: string;
        toolUseId: string;
        input: string;
        stop?: boolean;
    };
} | {
    type: "toolUseInput";
    data: {
        input: string;
    };
} | {
    type: "toolUseStop";
    data: {
        stop: boolean;
    };
} | {
    type: "contextUsage";
    data: {
        contextUsagePercentage: number;
    };
} | {
    type: "usage";
    data: {
        inputTokens?: number;
        outputTokens?: number;
    };
} | {
    type: "error";
    data: {
        error: string;
        message?: string;
    };
};
export declare function parseKiroEvent(payload: unknown): KiroEvent | undefined;
export declare function buildKiroRequest(model: Model<Api>, context: Context, profileArn: string, conversationId: string, reasoning?: SimpleStreamOptions["reasoning"]): KiroRequest;
export declare function parseStructuredApiKey(apiKey: string | undefined): {
    token: string;
    region?: string;
    profileArn?: string;
};
export declare function fetchKiroModelsForCredential(credential: {
    access: string;
    region?: string;
    profileArn?: string;
}, signal?: AbortSignal): Promise<readonly KiroProviderModelConfig[]>;
export declare function streamKiro(model: Model<Api>, context: Context, options?: StreamOptions | SimpleStreamOptions): AssistantMessageEventStream;
export {};
//# sourceMappingURL=stream.d.ts.map