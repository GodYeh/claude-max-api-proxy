/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */
import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(model),
        choices: [
            {
                index: 0,
                delta: {},
                finish_reason: "stop",
            },
        ],
    };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
    result: ClaudeCliResult,
    requestId: string
): OpenAIChatResponse {
    const modelName = result.modelUsage
        ? Object.keys(result.modelUsage)[0]
        : "claude-sonnet-4";

    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(modelName),
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: result.result,
                },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: result.usage?.input_tokens || 0,
            completion_tokens: result.usage?.output_tokens || 0,
            total_tokens:
                (result.usage?.input_tokens || 0) +
                (result.usage?.output_tokens || 0),
        },
    };
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
function normalizeModelName(model: string): string {
    if (model.includes("opus")) return "claude-opus-4";
    if (model.includes("sonnet")) return "claude-sonnet-4";
    if (model.includes("haiku")) return "claude-haiku-4";
    return model;
}
