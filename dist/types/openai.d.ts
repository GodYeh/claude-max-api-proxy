/**
 * Types for OpenAI-compatible API
 */
export interface OpenAIChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
    }>;
    tool_calls?: unknown[];
}
export interface OpenAIChatRequest {
    model: string;
    messages: OpenAIChatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    user?: string;
}
export interface OpenAIChatResponseChoice {
    index: number;
    message: {
        role: "assistant";
        content: string;
    };
    finish_reason: "stop" | "length" | "content_filter" | null;
}
export interface OpenAIChatResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: OpenAIChatResponseChoice[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export interface OpenAIChatChunkDelta {
    role?: "assistant";
    content?: string;
}
export interface OpenAIChatChunkChoice {
    index: number;
    delta: OpenAIChatChunkDelta;
    finish_reason: "stop" | "length" | "content_filter" | null;
}
export interface OpenAIChatChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: OpenAIChatChunkChoice[];
}
//# sourceMappingURL=openai.d.ts.map