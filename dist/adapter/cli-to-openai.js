// ─── Tool call parsing ──────────────────────────────────────────────
const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
/**
 * Parse <tool_call>...</tool_call> markers out of the full response text.
 *
 * The model emits tool calls in this format when external tools are provided:
 *   <tool_call>{"id":"call_1","name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>
 *
 * Per the OpenAI spec, function.arguments must be a JSON *string*, not an object.
 * If the model produces an object (which is easier for it to output reliably),
 * we normalize it to a JSON string here.
 */
export function parseToolCalls(text) {
    const toolCalls = [];
    // Reset lastIndex since the regex is module-level with /g flag
    TOOL_CALL_RE.lastIndex = 0;
    const textWithoutToolCalls = text.replace(TOOL_CALL_RE, (_, inner) => {
        try {
            const parsed = JSON.parse(inner.trim());
            const args = parsed.arguments;
            toolCalls.push({
                id: parsed.id || `call_${toolCalls.length + 1}`,
                type: "function",
                function: {
                    name: String(parsed.name || "unknown"),
                    // Normalize: OpenAI requires arguments as a JSON string
                    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
                },
            });
        }
        catch (e) {
            console.error("[parseToolCalls] Failed to parse tool call JSON:", inner, e);
        }
        return ""; // remove marker from response text
    }).trim();
    return {
        hasToolCalls: toolCalls.length > 0,
        toolCalls,
        textWithoutToolCalls,
    };
}
// ─── Streaming tool call chunks ────────────────────────────────────
/**
 * Create synthesized SSE chunks that represent tool calls in OpenAI streaming format.
 *
 * OpenAI streaming tool call protocol:
 *   1. First chunk:  role="assistant", tool_calls=[{index, id, type, function.name, function.arguments=""}]
 *   2. Argument chunks: tool_calls=[{index, function.arguments: "<partial_json>"}]
 *   3. Final chunk:  finish_reason="tool_calls", empty delta
 *
 * Since we buffer the full response before parsing, we emit everything at once
 * (no incremental argument streaming).
 */
export function createToolCallChunks(toolCalls, requestId, model) {
    const chunks = [];
    const base = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(model),
    };
    // Chunk 1: announce all tool calls (name + id, empty arguments string)
    chunks.push({
        ...base,
        choices: [{
                index: 0,
                delta: {
                    role: "assistant",
                    tool_calls: toolCalls.map((tc, i) => ({
                        index: i,
                        id: tc.id,
                        type: "function",
                        function: { name: tc.function.name, arguments: "" },
                    })),
                },
                finish_reason: null,
            }],
    });
    // Argument chunks: one per tool call, streaming the full arguments string
    for (let i = 0; i < toolCalls.length; i++) {
        chunks.push({
            ...base,
            choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                                index: i,
                                function: { arguments: toolCalls[i].function.arguments },
                            }],
                    },
                    finish_reason: null,
                }],
        });
    }
    // Final chunk: signal completion
    chunks.push({
        ...base,
        choices: [{
                index: 0,
                delta: {},
                finish_reason: "tool_calls",
            }],
    });
    return chunks;
}
// ─── Done chunk ────────────────────────────────────────────────────
/**
 * Create a final "done" chunk for streaming (normal text completion)
 */
export function createDoneChunk(requestId, model) {
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
// ─── Non-streaming response ────────────────────────────────────────
/**
 * Convert Claude CLI result to OpenAI non-streaming response.
 * Automatically detects and parses tool calls from the result text.
 */
export function cliResultToOpenai(result, requestId) {
    const modelName = result.modelUsage
        ? Object.keys(result.modelUsage)[0]
        : "claude-sonnet-4";
    const { hasToolCalls, toolCalls, textWithoutToolCalls } = parseToolCalls(result.result ?? "");
    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(modelName),
        choices: [
            hasToolCalls
                ? {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: toolCalls,
                    },
                    finish_reason: "tool_calls",
                }
                : {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: textWithoutToolCalls || result.result || "",
                    },
                    finish_reason: "stop",
                },
        ],
        usage: {
            prompt_tokens: result.usage?.input_tokens || 0,
            completion_tokens: result.usage?.output_tokens || 0,
            total_tokens: (result.usage?.input_tokens || 0) +
                (result.usage?.output_tokens || 0),
        },
    };
}
// ─── Helpers ───────────────────────────────────────────────────────
/**
 * Normalize Claude model names by stripping date suffixes.
 * e.g., "claude-sonnet-4-6-20250929" -> "claude-sonnet-4-6"
 */
function normalizeModelName(model) {
    return model.replace(/-\d{8}$/, "");
}
//# sourceMappingURL=cli-to-openai.js.map