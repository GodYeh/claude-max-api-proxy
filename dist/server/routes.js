import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, stripAssistantBleed } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, parseToolCalls, createToolCallChunks } from "../adapter/cli-to-openai.js";
// ── Auth Error Detection ────────────────────────────────────────────
const AUTH_ERROR_PATTERNS = ["not logged in", "please run /login"];
function isAuthError(text) {
    const lower = text.toLowerCase();
    return AUTH_ERROR_PATTERNS.some((p) => lower.includes(p));
}
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
 * Each content_delta event is immediately written to the response stream.
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
    // Send an empty role-announce chunk immediately.
    // Without this, short responses (entire content in one delta) arrive as a
    // single "complete-looking" SSE chunk, which causes some gateway consumers
    // (e.g. OpenClaw Slack delivery) to fire both their streaming-partial handler
    // AND their completion handler — delivering the same message twice.
    // By sending role:"assistant" with no content first, the gateway sees an
    // in-progress stream and waits for [DONE] before delivering, preventing dupes.
    const announceChunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "claude-sonnet-4",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(announceChunk)}\n\n`);
    return new Promise((resolve, reject) => {
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        let isFirst = false; // role:"assistant" already sent in the announce chunk above
        let allContent = ""; // Track all content for auth error detection
        // ── Bleed detection state ──────────────────────────────────
        // We accumulate streamed text to detect [User]/[Human] bleed patterns.
        // Once a bleed sentinel is detected, we stop forwarding further deltas.
        let accumulated = "";
        let totalFlushed = 0;
        let bleedDetected = false;
        // Longest sentinel we watch for, so we know how much tail to hold back
        const BLEED_SENTINELS = ["\n[User]", "\n[Human]", "\nHuman:"];
        const MAX_SENTINEL_LEN = Math.max(...BLEED_SENTINELS.map((s) => s.length));
        /**
         * Write a delta chunk to the SSE stream.
         */
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
        /**
         * Process an incoming delta with bleed detection.
         * We keep a tail buffer (MAX_SENTINEL_LEN chars) unwritten until we're
         * sure it doesn't start a bleed pattern — this prevents partial sentinels
         * (split across two deltas) from leaking through.
         */
        function processDelta(incoming) {
            if (bleedDetected || res.writableEnded)
                return;
            accumulated += incoming;
            // Check if the accumulated text contains a bleed sentinel
            const safe = stripAssistantBleed(accumulated);
            if (safe.length < accumulated.length) {
                // Bleed found — write only the unflushed safe portion and stop
                bleedDetected = true;
                const safeNew = safe.slice(totalFlushed);
                if (safeNew)
                    writeDelta(safeNew);
                console.error("[Stream] Bleed detected — halting delta stream");
                return;
            }
            // No bleed yet, but hold back the last MAX_SENTINEL_LEN chars as a
            // look-ahead buffer in case a sentinel straddles two delta chunks.
            const safeLen = Math.max(0, accumulated.length - MAX_SENTINEL_LEN);
            const toFlush = safeLen - totalFlushed;
            if (toFlush > 0) {
                writeDelta(accumulated.slice(totalFlushed, totalFlushed + toFlush));
                totalFlushed += toFlush;
            }
        }
        /**
         * Flush remaining buffered tail at end of stream.
         * Run through stripAssistantBleed one more time for safety.
         */
        function flushTail() {
            if (bleedDetected || res.writableEnded)
                return;
            const safe = stripAssistantBleed(accumulated);
            const remaining = safe.slice(totalFlushed);
            if (remaining)
                writeDelta(remaining);
        }
        // ──────────────────────────────────────────────────────────
        // Handle client disconnect
        res.on("close", () => {
            if (!isComplete)
                subprocess.kill();
            resolve();
        });
        // Log tool calls
        subprocess.on("message", (msg) => {
            if (msg.type !== "stream_event")
                return;
            const eventType = msg.event?.type;
            if (eventType === "content_block_start") {
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
        if (hasTools) {
            // ── Tool mode: buffer full response, parse tool calls at the end ──
            // We cannot stream incrementally because <tool_call> markers may span
            // multiple delta chunks. Buffer everything and emit synthesized chunks.
            let toolBuffer = "";
            subprocess.on("content_delta", (event) => {
                const text = event.event.delta?.text || "";
                toolBuffer += text;
                allContent += text;
            });
            subprocess.on("result", (_result) => {
                isComplete = true;
                // Detect auth errors before forwarding
                if (isAuthError(toolBuffer)) {
                    console.error("[Stream] Auth error detected in CLI output");
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({
                            error: { message: "Claude CLI is not authenticated. Run: claude login", type: "auth_error", code: "not_authenticated" },
                        })}\n\n`);
                        res.write("data: [DONE]\n\n");
                        res.end();
                    }
                    resolve();
                    return;
                }
                // Apply bleed strip then parse tool calls
                const safeText = stripAssistantBleed(toolBuffer);
                const { hasToolCalls, toolCalls, textWithoutToolCalls } = parseToolCalls(safeText);
                if (!res.writableEnded) {
                    if (hasToolCalls) {
                        // Emit synthesized tool call SSE chunks
                        const chunks = createToolCallChunks(toolCalls, requestId, lastModel);
                        for (const chunk of chunks) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                        // Use [DONE] as the sole end signal for tool call responses
                        // (tool call chunks already have finish_reason:"tool_calls")
                        res.write("data: [DONE]\n\n");
                    }
                    else {
                        // No tool calls — emit full text as a single content chunk
                        if (textWithoutToolCalls) {
                            writeDelta(textWithoutToolCalls);
                        }
                        const doneChunk = createDoneChunk(requestId, lastModel);
                        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                resolve();
            });
        }
        else {
            // ── Normal mode: stream deltas through bleed detection ────────────
            subprocess.on("content_delta", (event) => {
                const text = event.event.delta?.text || "";
                if (!text)
                    return;
                allContent += text;
                processDelta(text);
            });
            subprocess.on("result", (_result) => {
                isComplete = true;
                // Detect auth errors before forwarding
                if (isAuthError(allContent)) {
                    console.error("[Stream] Auth error detected in CLI output");
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({
                            error: { message: "Claude CLI is not authenticated. Run: claude login", type: "auth_error", code: "not_authenticated" },
                        })}\n\n`);
                        res.write("data: [DONE]\n\n");
                        res.end();
                    }
                    resolve();
                    return;
                }
                // Flush any buffered tail through bleed detection before finishing
                flushTail();
                if (!res.writableEnded) {
                    const doneChunk = createDoneChunk(requestId, lastModel);
                    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                resolve();
            });
        }
        subprocess.on("error", (error) => {
            console.error("[Streaming] Error:", error.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: error.message, type: "server_error", code: null },
                })}\n\n`);
                res.end();
            }
            resolve();
        });
        subprocess.on("close", (code) => {
            // Subprocess exited - ensure response is closed
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    // Abnormal exit without result - send error
                    res.write(`data: ${JSON.stringify({
                        error: {
                            message: `Process exited with code ${code}`,
                            type: "server_error",
                            code: null,
                        },
                    })}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        // Start the subprocess with session-aware options
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
                const resultText = finalResult.result ?? "";
                // Detect auth errors
                if (isAuthError(resultText)) {
                    console.error("[NonStreaming] Auth error detected in CLI output");
                    res.status(503).json({
                        error: { message: "Claude CLI is not authenticated. Run: claude login", type: "auth_error", code: "not_authenticated" },
                    });
                    resolve();
                    return;
                }
                // Strip any [User]/[Human] bleed from the final result text
                finalResult = {
                    ...finalResult,
                    result: stripAssistantBleed(resultText),
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
        // Start the subprocess with session-aware options
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
    res.json({
        object: "list",
        data: [
            { id: "claude-opus-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-sonnet-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-haiku-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
        ],
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