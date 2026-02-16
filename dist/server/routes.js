/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for OpenAI-compatible client integration
 */
import { v4 as uuidv4 } from "uuid";
import { spawn as nodeSpawn } from "child_process";
import path from "path";
import fs from "fs";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, extractModel } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";

// ── Telegram Progress Reporter ─────────────────────────────────────
// Shows real-time progress updates in Telegram while the CLI runs
// tool calls (Bash, WebSearch, Read, etc.). Sends one message on the
// first tool call, then edits it on subsequent calls, and deletes it
// when the final response is ready.

/**
 * Tool name → user-friendly Chinese progress label
 */
const TOOL_LABELS = {
    "Bash":       "執行命令",
    "Read":       "讀取檔案",
    "Write":      "寫入檔案",
    "Edit":       "編輯檔案",
    "Grep":       "搜尋內容",
    "Glob":       "搜尋檔案",
    "WebSearch":  "搜尋網頁",
    "WebFetch":   "讀取網頁",
    "TodoRead":   "讀取待辦",
    "TodoWrite":  "更新待辦",
};

/**
 * Read Telegram bot token from OpenClaw config (cached after first read).
 */
let _cachedBotToken = undefined;
function getTelegramBotToken() {
    if (_cachedBotToken !== undefined) return _cachedBotToken;
    try {
        const configPath = path.join(process.env.HOME || "/tmp", ".openclaw", "openclaw.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        _cachedBotToken = config?.channels?.telegram?.botToken || null;
    } catch (err) {
        console.error("[ProgressReporter] Failed to read bot token:", err.message);
        _cachedBotToken = null;
    }
    return _cachedBotToken;
}

/**
 * Call Telegram Bot API. Returns parsed JSON response or null on error.
 */
async function telegramApi(method, params) {
    const token = getTelegramBotToken();
    if (!token) return null;
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
    } catch (err) {
        console.error(`[TelegramAPI] ${method} error:`, err.message);
        return null;
    }
}

/**
 * Manages a single Telegram progress message that gets updated as
 * the CLI calls different tools. One instance per request.
 */
class ProgressReporter {
    chatId;          // Telegram chat ID to send to
    messageId;       // Telegram message_id of the progress message
    toolHistory;     // list of tool labels seen so far
    lastUpdateAt;    // timestamp of last edit (rate limiting)
    pendingLabel;    // label waiting to be sent (throttled)
    throttleTimer;   // setTimeout handle for throttled updates
    isDeleted;       // whether the progress message has been cleaned up

    static MIN_UPDATE_INTERVAL = 3000; // 3s between edits

    constructor(chatId) {
        this.chatId = chatId;
        this.messageId = null;
        this.toolHistory = [];
        this.lastUpdateAt = 0;
        this.pendingLabel = null;
        this.throttleTimer = null;
        this.isDeleted = false;
    }

    /**
     * Build the progress message text from tool history.
     * Shows a running log of tools used, e.g.:
     *   ⏳ 搜尋網頁...
     *      執行命令...
     *      讀取檔案...
     */
    _buildText() {
        if (this.toolHistory.length === 0) return "⏳ 處理中...";
        const lines = this.toolHistory.map((label, i) => {
            if (i === 0) return `⏳ ${label}...`;
            return `     ${label}...`;
        });
        return lines.join("\n");
    }

    /**
     * Report a new tool call. Sends or edits the progress message.
     */
    async report(toolName) {
        if (this.isDeleted) return;
        if (!this.chatId) return;

        const label = TOOL_LABELS[toolName] || toolName;

        // Don't repeat consecutive identical labels
        if (this.toolHistory.length > 0 && this.toolHistory[this.toolHistory.length - 1] === label) {
            return;
        }
        this.toolHistory.push(label);

        // Keep at most 6 lines to avoid giant messages
        if (this.toolHistory.length > 6) {
            this.toolHistory = this.toolHistory.slice(-6);
        }

        const now = Date.now();
        const elapsed = now - this.lastUpdateAt;

        if (elapsed >= ProgressReporter.MIN_UPDATE_INTERVAL) {
            await this._flush();
        } else {
            // Throttle: schedule an update after the interval
            this.pendingLabel = label;
            if (!this.throttleTimer) {
                this.throttleTimer = setTimeout(async () => {
                    this.throttleTimer = null;
                    if (!this.isDeleted) {
                        await this._flush();
                    }
                }, ProgressReporter.MIN_UPDATE_INTERVAL - elapsed);
            }
        }
    }

    /**
     * Actually send or edit the Telegram message.
     */
    async _flush() {
        if (this.isDeleted) return;
        this.lastUpdateAt = Date.now();
        this.pendingLabel = null;

        const text = this._buildText();

        if (!this.messageId) {
            // First time: send a new message
            const result = await telegramApi("sendMessage", {
                chat_id: this.chatId,
                text,
                disable_notification: true,
            });
            if (result?.ok) {
                this.messageId = result.result.message_id;
                console.error(`[ProgressReporter] Sent progress message #${this.messageId}`);
            }
        } else {
            // Subsequent: edit existing message
            await telegramApi("editMessageText", {
                chat_id: this.chatId,
                message_id: this.messageId,
                text,
            });
            console.error(`[ProgressReporter] Updated progress message #${this.messageId}: ${this.toolHistory[this.toolHistory.length - 1]}`);
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
 * Requires TELEGRAM_NOTIFY_ID env var (e.g. "123456789").
 */
function notifyTelegram(message) {
    const telegramId = process.env.TELEGRAM_NOTIFY_ID;
    if (!telegramId) {
        console.error("[notifyTelegram] Skipped — TELEGRAM_NOTIFY_ID not set");
        return;
    }
    const ocTool = path.join(process.env.HOME || "/tmp", ".openclaw", "bin", "oc-tool");
    const args = ["message", "send", JSON.stringify({
        channel: "telegram",
        target: `telegram:${telegramId}`,
        message,
    })];
    try {
        const proc = nodeSpawn(ocTool, args, {
            env: { ...process.env },
            stdio: "ignore",
            detached: true,
        });
        proc.unref();
    } catch (err) {
        console.error("[notifyTelegram] Failed:", err.message);
    }
}
/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
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
        const conversationId = body.user; // OpenClaw conversation ID
        let hasExistingSession = false;
        let claudeSessionId = undefined;
        if (conversationId) {
            const existing = sessionManager.get(conversationId);
            if (existing) {
                hasExistingSession = true;
                claudeSessionId = existing.claudeSessionId;
                existing.lastUsedAt = Date.now();
                existing.messageCount = (existing.messageCount || 0) + 1;
                sessionManager.save().catch(err =>
                    console.error("[SessionManager] Save error:", err));
                console.error(`[Session] Resuming: ${conversationId} -> ${claudeSessionId} (msg #${existing.messageCount})`);
            } else {
                claudeSessionId = sessionManager.getOrCreate(conversationId, extractModel(body.model));
                console.error(`[Session] New: ${conversationId} -> ${claudeSessionId}`);
            }
        }
        // Convert to CLI input format (only latest message if resuming)
        const cliInput = openaiToCli(body, hasExistingSession);
        const subprocess = new ClaudeSubprocess();
        // Build subprocess options with session info
        const subOpts = {
            model: cliInput.model,
            systemPrompt: cliInput.systemPrompt,
        };
        if (hasExistingSession && claudeSessionId) {
            subOpts.resumeSessionId = claudeSessionId;
        } else if (claudeSessionId) {
            subOpts.sessionId = claudeSessionId;
        }
        // Handle resume failures: invalidate session so next request starts fresh
        subprocess.on("resume_failed", (errorText) => {
            console.error(`[Session] Resume failed, invalidating: ${conversationId}`);
            if (conversationId) {
                sessionManager.delete(conversationId);
            }
        });
        if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId, subOpts);
        }
        else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId, subOpts);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            res.status(500).json({
                error: {
                    message,
                    type: "server_error",
                    code: null,
                },
            });
        }
    }
}
/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(req, res, subprocess, cliInput, requestId, subOpts) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    // CRITICAL: Flush headers immediately to establish SSE connection
    // Without this, headers are buffered and client times out waiting
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");
    return new Promise((resolve, reject) => {
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        // ── Smart Streaming ──────────────────────────────────────────
        // Buffer content deltas per turn. When a new turn starts
        // (message_start), discard the previous buffer (it was an
        // intermediate tool-calling turn). On "result", flush the
        // final turn's buffer as SSE chunks so the client only sees
        // the last assistant reply.
        let turnBuffer = []; // accumulated delta texts for current turn
        let turnCount = 0;
        // ── Progress Reporter ────────────────────────────────────────
        // Send real-time progress updates to Telegram as tools are called.
        // Uses TELEGRAM_NOTIFY_ID as the chat target.
        const telegramChatId = process.env.TELEGRAM_NOTIFY_ID || null;
        const progress = new ProgressReporter(telegramChatId);
        // Handle actual client disconnect (response stream closed)
        res.on("close", () => {
            if (!isComplete) {
                // Client disconnected before response completed - kill subprocess
                subprocess.kill();
                progress.cleanup().catch(() => {});
            }
            resolve();
        });
        // Detect turn boundaries and tool calls via stream events
        subprocess.on("message", (msg) => {
            if (msg.type !== "stream_event") return;
            const eventType = msg.event?.type;
            // Tool call detection: content_block_start with type "tool_use"
            if (eventType === "content_block_start") {
                const block = msg.event.content_block;
                if (block?.type === "tool_use" && block.name) {
                    console.error(`[SmartStream] Tool call: ${block.name}`);
                    progress.report(block.name).catch(() => {});
                }
            }
            // Turn boundary: message_start
            if (eventType === "message_start") {
                turnCount++;
                if (turnBuffer.length > 0) {
                    const discardedText = turnBuffer.join("");
                    console.error(`[SmartStream] New turn #${turnCount} — discarding ${turnBuffer.length} buffered deltas from previous turn: "${discardedText.slice(0, 200)}"`);
                }
                turnBuffer = [];
            }
        });
        // Buffer content deltas instead of writing immediately
        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text) {
                turnBuffer.push(text);
            }
        });
        // Handle final assistant message (for model name)
        subprocess.on("assistant", (message) => {
            lastModel = message.message.model;
        });
        subprocess.on("result", (_result) => {
            isComplete = true;
            // Clean up progress message before sending final response
            progress.cleanup().catch(() => {});
            if (!res.writableEnded) {
                // Flush all buffered deltas from the final turn as SSE chunks
                console.error(`[SmartStream] Flushing ${turnBuffer.length} deltas from final turn #${turnCount}`);
                let isFirst = true;
                for (const text of turnBuffer) {
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
                turnBuffer = [];
                // Send final done chunk with finish_reason
                const doneChunk = createDoneChunk(requestId, lastModel);
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        subprocess.on("error", (error) => {
            console.error("[Streaming] Error:", error.message);
            // Clean up progress message
            progress.cleanup().catch(() => {});
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
                        error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
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
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
        subprocess.on("close", (code) => {
            if (finalResult) {
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
        subprocess
            .start(cliInput.prompt, subOpts)
            .catch((error) => {
            res.status(500).json({
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
    });
}
/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: [
            {
                id: "claude-opus-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-sonnet-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-haiku-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
        ],
    });
}
/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
    });
}
