import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, stripAssistantBleed } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, parseToolCalls, createToolCallChunks } from "../adapter/cli-to-openai.js";
import { BleedDetector } from "./bleed-detector.js";
import { AVAILABLE_MODELS } from "../models.js";
// ── Route Handlers ─────────────────────────────────────────────────
/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming.
 */
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    try {
        // Validate request
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: {
                    message: "messages is required and must be a non-empty array",
                    type: "invalid_request_error",
                    code: "invalid_messages",
                },
            });
            return;
        }
        // Convert to CLI input format
        const cliInput = openaiToCli(body);
        const subOpts = {
            model: cliInput.model,
            systemPrompt: cliInput.systemPrompt,
        };
        const subprocess = new ClaudeSubprocess();
        // External tool calling: present and not explicitly disabled
        const hasTools = Array.isArray(body.tools) &&
            body.tools.length > 0 &&
            body.tool_choice !== "none";
        if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId, subOpts, hasTools);
        }
        else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId, subOpts);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const stack = error instanceof Error ? error.stack : "";
        console.error("[handleChatCompletions] Error:", message);
        console.error("[handleChatCompletions] Stack:", stack);
        if (!res.headersSent) {
            res.status(500).json({
                error: { message, type: "server_error", code: null },
            });
        }
    }
}
/**
 * Handle streaming response (SSE)
 *
 * Normal mode streams deltas through bleed detection.
 * Tool mode buffers the full response then emits synthesized SSE chunks,
 * because <tool_call> markers may span multiple delta chunks.
 */
async function handleStreamingResponse(req, res, subprocess, cliInput, requestId, subOpts, hasTools = false) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");
    return new Promise((resolve, reject) => {
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        let isFirst = true;
        const bleed = hasTools ? null : new BleedDetector();
        let toolBuffer = "";
        function writeDelta(text) {
            if (!text || res.writableEnded)
                return;
            const chunk = {
                id: `chatcmpl-${requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: lastModel,
                choices: [{
                        index: 0,
                        delta: {
                            role: isFirst ? "assistant" : undefined,
                            content: text,
                        },
                        finish_reason: null,
                    }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            isFirst = false;
        }
        function writeSSE(obj) {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
        }
        // Handle client disconnect
        res.on("close", () => {
            if (!isComplete)
                subprocess.kill();
            resolve();
        });
        // Log native tool calls from the CLI
        subprocess.on("message", (msg) => {
            if (msg.type !== "stream_event")
                return;
            if (msg.event?.type === "content_block_start") {
                const block = msg.event.content_block;
                if (block?.type === "tool_use" && block.name) {
                    console.error(`[Stream] Tool call: ${block.name}`);
                }
            }
        });
        // Track model name from assistant messages
        subprocess.on("assistant", (message) => {
            lastModel = message.message.model;
        });
        // ── Content delta ──────────────────────────────────────────
        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (!text)
                return;
            if (hasTools) {
                toolBuffer += text;
            }
            else {
                const out = bleed.push(text);
                if (out)
                    writeDelta(out);
            }
        });
        // ── Result ─────────────────────────────────────────────────
        subprocess.on("result", (_result) => {
            isComplete = true;
            if (res.writableEnded) {
                resolve();
                return;
            }
            if (hasTools) {
                // Buffer is complete — strip bleed then parse tool calls
                const safeText = stripAssistantBleed(toolBuffer);
                const { hasToolCalls, toolCalls, textWithoutToolCalls } = parseToolCalls(safeText);
                if (hasToolCalls) {
                    // Emit synthesized tool call SSE chunks
                    for (const chunk of createToolCallChunks(toolCalls, requestId, lastModel)) {
                        writeSSE(chunk);
                    }
                }
                else {
                    // No tool calls — emit full text as a single content chunk
                    if (textWithoutToolCalls)
                        writeDelta(textWithoutToolCalls);
                    writeSSE(createDoneChunk(requestId, lastModel));
                }
            }
            else {
                // Flush the bleed-detection tail buffer
                const tail = bleed.flush();
                if (tail)
                    writeDelta(tail);
                writeSSE(createDoneChunk(requestId, lastModel));
            }
            res.write("data: [DONE]\n\n");
            res.end();
            resolve();
        });
        // ── Error / Close ──────────────────────────────────────────
        subprocess.on("error", (error) => {
            console.error("[Streaming] Error:", error.message);
            if (!res.writableEnded) {
                writeSSE({ error: { message: error.message, type: "server_error", code: null } });
                res.end();
            }
            resolve();
        });
        subprocess.on("close", (code) => {
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    writeSSE({
                        error: {
                            message: `Process exited with code ${code}`,
                            type: "server_error",
                            code: null,
                        },
                    });
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        // Start the subprocess
        subprocess.start(cliInput.prompt, subOpts).catch((err) => {
            console.error("[Streaming] Subprocess start error:", err);
            reject(err);
        });
    });
}
/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(res, subprocess, cliInput, requestId, subOpts) {
    return new Promise((resolve) => {
        let finalResult = null;
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            res.status(500).json({
                error: { message: error.message, type: "server_error", code: null },
            });
            resolve();
        });
        subprocess.on("close", (code) => {
            if (finalResult) {
                // Strip any [User]/[Human] bleed from the final result text
                finalResult = {
                    ...finalResult,
                    result: stripAssistantBleed(finalResult.result ?? ""),
                };
                res.json(cliResultToOpenai(finalResult, requestId));
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });
        subprocess.start(cliInput.prompt, subOpts).catch((error) => {
            res.status(500).json({
                error: { message: error.message, type: "server_error", code: null },
            });
            resolve();
        });
    });
}
/**
 * Handle GET /v1/models — Returns available models
 */
export function handleModels(_req, res) {
    const created = Math.floor(Date.now() / 1000);
    res.json({
        object: "list",
        data: AVAILABLE_MODELS.map((m) => ({
            id: m.id,
            object: "model",
            owned_by: "anthropic",
            created,
        })),
    });
}
/**
 * Handle GET /health — Health check endpoint
 */
export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
    });
}
//# sourceMappingURL=routes.js.map