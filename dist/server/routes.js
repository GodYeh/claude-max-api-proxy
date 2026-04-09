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
// ── Concurrency Limit ──────────────────────────────────────────────
// Each in-flight chat request spawns a Claude CLI subprocess, which is
// expensive (hundreds of MB of RAM each). Cap concurrency to avoid
// OOM-killing the box on a burst of requests. Excess requests get a
// 429 with Retry-After so well-behaved clients back off cleanly.
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_CONCURRENT = (() => {
    const raw = process.env.CLAUDE_PROXY_MAX_CONCURRENT;
    if (!raw)
        return DEFAULT_MAX_CONCURRENT;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT;
})();
let activeRequests = 0;
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
    // Reject early if we are already at the configured concurrency cap.
    // Each handler spawns a separate Claude CLI subprocess (~200+ MB RSS),
    // so unbounded concurrency will OOM the box on a burst.
    if (activeRequests >= MAX_CONCURRENT) {
        console.error(`[handleChatCompletions] Rejecting request — at concurrency limit ${activeRequests}/${MAX_CONCURRENT}`);
        res.setHeader("Retry-After", "5");
        res.status(429).json({
            error: {
                message: `Too many concurrent requests (limit ${MAX_CONCURRENT}). Retry shortly.`,
                type: "rate_limit_error",
                code: "concurrency_limit",
            },
        });
        return;
    }
    activeRequests += 1;
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
        // The client-supplied model string is what we echo back in chunks,
        // not the CLI-mapped value (which may collapse to "opus"/"sonnet").
        const clientModel = typeof body.model === "string" && body.model ? body.model : "claude-sonnet-4";
        if (stream) {
            await handleStreamingResponse(res, subprocess, cliInput, requestId, subOpts, clientModel, hasTools);
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
        else if (!res.writableEnded) {
            // Headers were already flushed for SSE (we sent the role-announce
            // chunk before subprocess.start() ran), so we cannot fall back to
            // res.status(500).json(). Instead, write a structured error event
            // followed by [DONE] so streaming clients see a real failure
            // instead of a silently truncated stream.
            try {
                res.write(`data: ${JSON.stringify({
                    error: { message, type: "server_error", code: null },
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            catch (writeErr) {
                console.error("[handleChatCompletions] Failed to write SSE error fallback:", writeErr);
            }
        }
    }
    finally {
        activeRequests -= 1;
    }
}
/**
 * Handle streaming response (SSE)
 *
 * Each content_delta event is immediately written to the response stream.
 */
async function handleStreamingResponse(res, subprocess, cliInput, requestId, subOpts, clientModel, hasTools = false) {
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
        model: clientModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(announceChunk)}\n\n`);
    return new Promise((resolve, reject) => {
        // Default to the client-requested model so the very first content
        // chunks aren't tagged with the wrong family. The CLI will overwrite
        // this with the real model id once the assistant message arrives.
        let lastModel = clientModel;
        let isComplete = false;
        // ── Bleed detection state ──────────────────────────────────
        // We hold back a small tail buffer (MAX_SENTINEL_LEN bytes) so a
        // bleed sentinel that straddles two delta chunks is still caught,
        // without rescanning the entire response on every delta.
        let tail = "";
        let bleedDetected = false;
        const BLEED_SENTINELS = ["\n[User]", "\n[Human]", "\nHuman:"];
        const MAX_SENTINEL_LEN = Math.max(...BLEED_SENTINELS.map((s) => s.length));
        // ── Auth-error probe state ─────────────────────────────────
        // Hold back the first AUTH_PROBE_BYTES of streamed text so we can
        // detect "not logged in" before any of it is forwarded to the client.
        // Once the buffer is large enough — or the stream ends — we either
        // emit an auth error or flush the buffer through the normal pipeline.
        const AUTH_PROBE_BYTES = 1024;
        let authProbe = "";
        let authProbeCleared = false;
        /**
         * Write a content delta chunk to the SSE stream.
         * The role:"assistant" announcement was already sent up-front, so
         * subsequent deltas only carry the content payload.
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
                        delta: { content: text },
                        finish_reason: null,
                    }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        /**
         * Process an incoming delta with bleed detection.
         * Keeps a tail buffer (MAX_SENTINEL_LEN chars) unwritten until the
         * next delta arrives so a sentinel split across two deltas is still
         * caught, while running in O(incoming.length + MAX_SENTINEL_LEN) per
         * call instead of rescanning the full accumulated response each time.
         */
        function processDelta(incoming) {
            if (bleedDetected || res.writableEnded || !incoming)
                return;
            const buf = tail + incoming;
            // Search only the (small) tail+incoming window for sentinels.
            // The earlier flushed prefix has already been cleared by previous
            // calls, so any sentinel must lie within this window.
            let cutAt = -1;
            for (const sentinel of BLEED_SENTINELS) {
                const idx = buf.indexOf(sentinel);
                if (idx !== -1 && (cutAt === -1 || idx < cutAt)) {
                    cutAt = idx;
                }
            }
            if (cutAt !== -1) {
                bleedDetected = true;
                const safe = buf.slice(0, cutAt);
                if (safe)
                    writeDelta(safe);
                tail = "";
                console.error("[Stream] Bleed detected — halting delta stream");
                return;
            }
            // Hold back the last MAX_SENTINEL_LEN chars as a look-ahead buffer.
            if (buf.length > MAX_SENTINEL_LEN) {
                const flushUntil = buf.length - MAX_SENTINEL_LEN;
                writeDelta(buf.slice(0, flushUntil));
                tail = buf.slice(flushUntil);
            }
            else {
                tail = buf;
            }
        }
        /**
         * Flush remaining buffered tail at end of stream.
         * Run through stripAssistantBleed one more time for safety.
         */
        function flushTail() {
            if (bleedDetected || res.writableEnded || !tail)
                return;
            const safe = stripAssistantBleed(tail);
            if (safe)
                writeDelta(safe);
            tail = "";
        }
        /**
         * Emit a structured auth error and tear down the stream.
         * Used by both the early probe (in delta handler) and the late
         * fallback (in result handler) so the wire format stays identical.
         */
        function emitAuthError() {
            console.error("[Stream] Auth error detected — aborting stream");
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: "Claude CLI is not authenticated. Run: claude login", type: "auth_error", code: "not_authenticated" },
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            isComplete = true;
            subprocess.kill();
            resolve();
        }
        /**
         * Buffer the first AUTH_PROBE_BYTES of streamed text and only forward
         * it once we are confident it is not an auth error. This prevents
         * "not logged in" content from leaking to the client before we can
         * replace it with a structured auth_error.
         *
         * Returns true if the stream should keep running, false if we have
         * already terminated it (auth error confirmed).
         */
        function ingestDelta(text) {
            if (authProbeCleared) {
                processDelta(text);
                return true;
            }
            authProbe += text;
            if (isAuthError(authProbe)) {
                emitAuthError();
                return false;
            }
            if (authProbe.length >= AUTH_PROBE_BYTES) {
                authProbeCleared = true;
                const drained = authProbe;
                authProbe = "";
                processDelta(drained);
            }
            return true;
        }
        /**
         * Drain the auth probe buffer at end-of-stream. Returns false if an
         * auth error was detected (caller should bail out without writing
         * the normal completion chunks).
         */
        function drainAuthProbe() {
            if (authProbeCleared || !authProbe)
                return true;
            if (isAuthError(authProbe)) {
                emitAuthError();
                return false;
            }
            authProbeCleared = true;
            const drained = authProbe;
            authProbe = "";
            processDelta(drained);
            return true;
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
            const event = msg.event;
            if (event.type === "content_block_start") {
                const block = event.content_block;
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
                        // Emit synthesized tool call SSE chunks. The chunks
                        // already include a finish_reason:"tool_calls" terminator,
                        // so we only need a single [DONE] sentinel after them.
                        const chunks = createToolCallChunks(toolCalls, requestId, lastModel);
                        for (const chunk of chunks) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
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
            // ── Normal mode: stream deltas through auth-probe + bleed pipeline ─
            subprocess.on("content_delta", (event) => {
                const text = event.event.delta?.text || "";
                if (!text)
                    return;
                ingestDelta(text);
            });
            subprocess.on("result", (_result) => {
                isComplete = true;
                // Drain any held-back auth probe before finishing.
                // drainAuthProbe() returns false if it terminated the stream
                // with an auth error — in which case we have nothing more to do.
                if (!drainAuthProbe())
                    return;
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
        // Each call to subprocess events fires from independent emitters,
        // so error/close/start can race. The first one to write the response
        // owns it; everything else must early-return.
        let responded = false;
        const respond = (fn) => {
            if (responded || res.headersSent) {
                responded = true;
                return;
            }
            responded = true;
            fn();
        };
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            respond(() => {
                res.status(500).json({
                    error: { message: error.message, type: "server_error", code: null },
                });
            });
            resolve();
        });
        subprocess.on("close", (code) => {
            respond(() => {
                if (finalResult) {
                    const resultText = finalResult.result ?? "";
                    // Detect auth errors
                    if (isAuthError(resultText)) {
                        console.error("[NonStreaming] Auth error detected in CLI output");
                        res.status(503).json({
                            error: { message: "Claude CLI is not authenticated. Run: claude login", type: "auth_error", code: "not_authenticated" },
                        });
                        return;
                    }
                    // Strip any [User]/[Human] bleed from the final result text
                    finalResult = {
                        ...finalResult,
                        result: stripAssistantBleed(resultText),
                    };
                    res.json(cliResultToOpenai(finalResult, requestId));
                }
                else {
                    res.status(500).json({
                        error: {
                            message: `Claude CLI exited with code ${code} without response`,
                            type: "server_error",
                            code: null,
                        },
                    });
                }
            });
            resolve();
        });
        // Start the subprocess with session-aware options
        subprocess.start(cliInput.prompt, subOpts).catch((error) => {
            respond(() => {
                res.status(500).json({
                    error: { message: error.message, type: "server_error", code: null },
                });
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