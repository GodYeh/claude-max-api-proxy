/**
 * Types for OpenAI-compatible API
 */
export interface OpenAIToolFunction {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}
export interface OpenAITool {
    type: "function";
    function: OpenAIToolFunction;
}
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
/**
 * Partial tool call used inside streaming chunk deltas.
 * Only "index" is required; other fields are optional because
 * argument-streaming chunks only carry {index, function.arguments}.
 */
export interface OpenAIToolCallDelta {
    index: number;
    id?: string;
    type?: "function";
    function?: {
        name?: string;
        arguments?: string;
    };
}
export interface OpenAIChatMessage {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    /** null is valid for assistant messages that are pure tool calls */
    content: string | null | Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
    }>;
    tool_calls?: OpenAIToolCall[];
    /** Present on role="tool" messages — references the originating tool_call.id */
    tool_call_id?: string;
    /** Present on role="tool" messages — the function name */
    name?: string;
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
    tools?: OpenAITool[];
    tool_choice?: "auto" | "none" | "required" | {
        type: "function";
        function: {
            name: string;
        };
    };
}
export interface OpenAIChatResponseChoice {
    index: number;
    message: {
        role: "assistant";
        content: string | null;
        tool_calls?: OpenAIToolCall[];
    };
    finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
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
    content?: string | null;
    tool_calls?: OpenAIToolCallDelta[];
}
export interface OpenAIChatChunkChoice {
    index: number;
    delta: OpenAIChatChunkDelta;
    finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}
export interface OpenAIChatChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: OpenAIChatChunkChoice[];
}
//# sourceMappingURL=openai.d.ts.map