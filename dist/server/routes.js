import { v4 as uuidv4 } from "uuid";
import { spawn as nodeSpawn } from "child_process";
import path from "path";
import fs from "fs";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, extractModel, stripAssistantBleed } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, parseToolCalls, createToolCallChunks } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";
// ── Telegram Progress Reporter ─────────────────────────────────────
// Shows real-time progress updates in Telegram while the CLI runs
// tool calls (Bash, WebSearch, Read, etc.). Sends one message on the
// first tool call, then edits it on subsequent calls, and deletes it
// when the final response is ready.
const TOOL_LABELS = {
    "Bash": "執行命令",
    "Read": "讀取檔案",
    "Write": "寫入檔案",
    "Edit": "編輯檔案",
    "Grep": "搜尋內容",
    "Glob": "搜尋檔案",
    "WebSearch": "搜尋網頁",
    "WebFetch": "讀取網頁",
    "TodoRead": "讀取待辦",
    "TodoWrite": "更新待辦",
};
let _cachedBotToken = undefined;
function getTelegramBotToken() {
    if (_cachedBotToken !== undefined)
        return _cachedBotToken;
    try {
        const configPath = path.join(process.env.HOME || "/tmp", ".openclaw", "openclaw.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        _cachedBotToken = config?.channels?.telegram?.botToken || null;
    }
    catch (err) {
        console.error("[ProgressReporter] Failed to read bot token:", err.message);
        _cachedBotToken = null;
    }
    return _cachedBotToken;
}
async function telegramApi(method, params) {
    const token = getTelegramBotToken();
    if (!token)
        return null;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        const data = await resp.json();
        if (!data.ok) {
            console.error(`[TelegramAPI] ${method} failed:`, data.description);
        }
        return data;
    }
    catch (err) {
        console.error(`[TelegramAPI] ${method} error:`, err.message);
        return null;
    }
}
/**
 * Manages a single Telegram progress message that gets updated as
 * the CLI calls different tools. One instance per request.
 */
class ProgressReporter {
    static MIN_UPDATE_INTERVAL = 3000; // 3s between edits
    chatId;
    messageId = null;
    toolHistory = [];
    lastUpdateAt = 0;
    pendingLabel = null;
    throttleTimer = null;
    isDeleted = false;
    constructor(chatId) {
        this.chatId = chatId;
    }
    /**
     * Build the progress message text from tool history.
     */
    _buildText() {
        if (this.toolHistory.length === 0)
            return "⏳ 處理中...";
        const lines = this.toolHistory.map((label, i) => {
            if (i === 0)
                return `⏳ ${label}...`;
            return `     ${label}...`;
        });
        return lines.join("\n");
    }
    /**
     * Report a new tool call. Sends or edits the progress message.
     */
    async report(toolName) {
        if (this.isDeleted || !this.chatId)
            return;
        const label = TOOL_LABELS[toolName] || toolName;
        if (this.toolHistory.length > 0 && this.toolHistory[this.toolHistory.length - 1] === label)
            return;
        this.toolHistory.push(label);
        if (this.toolHistory.length > 6)
            this.toolHistory = this.toolHistory.slice(-6);
        const now = Date.now();
        const elapsed = now - this.lastUpdateAt;
        if (elapsed >= ProgressReporter.MIN_UPDATE_INTERVAL) {
            await this._flush();
        }
        else {
            this.pendingLabel = label;
            if (!this.throttleTimer) {
                this.throttleTimer = setTimeout(async () => {
                    this.throttleTimer = null;
                    if (!this.isDeleted)
                        await this._flush();
                }, ProgressReporter.MIN_UPDATE_INTERVAL - elapsed);
            }
        }
    }
    /**
     * Actually send or edit the Telegram message.
     */
    async _flush() {
        if (this.isDeleted)
            return;
        this.lastUpdateAt = Date.now();
        this.pendingLabel = null;
        const text = this._buildText();
        if (!this.messageId) {
            const result = await telegramApi("sendMessage", {
                chat_id: this.chatId,
                text,
                disable_notification: true,
            });
            if (result?.ok) {
                this.messageId = result.result.message_id;
                console.error(`[ProgressReporter] Sent progress message #${this.messageId}`);
            }
        }
        else {
            await telegramApi("editMessageText", {
                chat_id: this.chatId,
                message_id: this.messageId,
                text,
            });
        }
    }
    /**
     * Clean up: delete the progress message when the final response arrives.
     */
    async cleanup() {
        this.isDeleted = true;
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        if (this.messageId && this.chatId) {
            await telegramApi("deleteMessage", {
                chat_id: this.chatId,
                message_id: this.messageId,
            });
            console.error(`[ProgressReporter] Deleted progress message #${this.messageId}`);
        }
    }
}
/**
 * Send a notification message to Telegram via oc-tool.
 * Fire-and-forget — errors are logged but don't affect the caller.
 */
function notifyTelegram(message) {
    const telegramId = process.env.TELEGRAM_NOTIFY_ID;
    if (!telegramId)
        return;
    const ocTool = path.join(process.env.HOME || "/tmp", ".openclaw", "bin", "oc-tool");
    try {
        const proc = nodeSpawn(ocTool, ["message", "send", JSON.stringify({
                channel: "telegram",
                target: `telegram:${telegramId}`,
                message,
            })], { env: { ...process.env }, stdio: "ignore", detached: true });
        proc.unref();
    }
    catch (err) {
        console.error("[notifyTelegram] Failed:", err.message);
    }
}
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
        // Session management: determine if we should resume an existing session
        const conversationId = body.user;
        let hasExistingSession = false;
        let claudeSessionId;
        if (conversationId) {
            const existing = sessionManager.get(conversationId);
            if (existing) {
                hasExistingSession = true;
                claudeSessionId = existing.claudeSessionId;
                existing.lastUsedAt = Date.now();
                sessionManager.save().catch((err) => console.error("[SessionManager] Save error:", err));
                console.error(`[Session] Resuming: ${conversationId} -> ${claudeSessionId}`);
            }
            else {
                claudeSessionId = sessionManager.getOrCreate(conversationId, extractModel(body.model));
                console.error(`[Session] New: ${conversationId} -> ${claudeSessionId}`);
            }
        }
        // Convert to CLI input format (only latest message if resuming)
        const cliInput = openaiToCli(body, hasExistingSession);
        // Build subprocess options with session info
        const subOpts = {
            model: cliInput.model,
            systemPrompt: cliInput.systemPrompt,
        };
        if (hasExistingSession && claudeSessionId) {
            subOpts.resumeSessionId = claudeSessionId;
        }
        else if (claudeSessionId) {
            subOpts.sessionId = claudeSessionId;
        }
        const subprocess = new ClaudeSubprocess();
        // Handle resume failures: invalidate session so next request starts fresh
        subprocess.on("resume_failed", () => {
            console.error(`[Session] Resume failed, invalidating: ${conversationId}`);
            if (conversationId)
                sessionManager.delete(conversationId);
        });
        // External tool calling: present and not explicitly disabled
        const hasTools = Array.isArray(body.tools) &&
            body.tools.length > 0 &&
            body.tool_choice !== "none";
        subOpts.hasExternalTools = hasTools;
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
                // Bleed found — write the safe portion and stop
                bleedDetected = true;
                // Only write the part we haven't written yet
                const alreadyWritten = accumulated.length - incoming.length;
                const safeNew = safe.slice(alreadyWritten);
                if (safeNew)
                    writeDelta(safeNew);
                console.error("[Stream] Bleed detected — halting delta stream");
                return;
            }
            // No bleed yet, but hold back the last MAX_SENTINEL_LEN chars as a
            // look-ahead buffer in case a sentinel straddles two delta chunks.
            const safeLen = Math.max(0, accumulated.length - MAX_SENTINEL_LEN);
            const alreadyFlushed = accumulated.length - incoming.length;
            const toFlush = safeLen - alreadyFlushed;
            if (toFlush > 0) {
                writeDelta(accumulated.slice(alreadyFlushed, alreadyFlushed + toFlush));
            }
        }
        /**
         * Flush remaining buffered tail at end of stream.
         * Run through stripAssistantBleed one more time for safety.
         */
        function flushTail() {
            if (bleedDetected || res.writableEnded)
                return;
            const alreadyFlushed = Math.max(0, accumulated.length - MAX_SENTINEL_LEN);
            const tail = accumulated.slice(alreadyFlushed);
            if (!tail)
                return;
            const safe = stripAssistantBleed(accumulated).slice(alreadyFlushed);
            if (safe)
                writeDelta(safe);
        }
        // ──────────────────────────────────────────────────────────
        // Progress reporter for Telegram
        const telegramChatId = process.env.TELEGRAM_NOTIFY_ID || null;
        const progress = new ProgressReporter(telegramChatId);
        // Handle client disconnect
        res.on("close", () => {
            if (!isComplete)
                subprocess.kill();
            progress.cleanup().catch(() => { });
            resolve();
        });
        // Detect tool calls for progress reporting
        subprocess.on("message", (msg) => {
            if (msg.type !== "stream_event")
                return;
            const eventType = msg.event?.type;
            if (eventType === "content_block_start") {
                const block = msg.event.content_block;
                if (block?.type === "tool_use" && block.name) {
                    console.error(`[Stream] Tool call: ${block.name}`);
                    progress.report(block.name).catch(() => { });
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
                progress.cleanup().catch(() => { });
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
                    progress.cleanup().catch(() => { });
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
                // Clean up progress message before sending final response
                progress.cleanup().catch(() => { });
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
            // Clean up progress message
            progress.cleanup().catch(() => { });
            // Notify via Telegram if it's a timeout
            if (error.message.includes("timed out")) {
                notifyTelegram(`⚠️ 任務超時被終止：${error.message}`);
            }
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
            if (error.message.includes("timed out")) {
                notifyTelegram(`⚠️ 任務超時被終止：${error.message}`);
            }
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