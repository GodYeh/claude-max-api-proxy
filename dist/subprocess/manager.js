/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs";
import { isAssistantMessage, isResultMessage, isContentDelta, } from "../types/claude-cli.js";
const PROXY_CWD = path.join(process.env.HOME || "/tmp", ".openclaw", "workspace");
// ── Gateway token resolution ────────────────────────────────────
// Read OPENCLAW_GATEWAY_TOKEN from openclaw.json if not in env.
// This enables oc-tool (cross-channel messaging, browser, cron, etc.)
// to authenticate with the gateway from within Claude CLI subprocesses.
let _gatewayToken;
function resolveGatewayToken() {
    if (_gatewayToken !== undefined)
        return _gatewayToken;
    // Prefer env var if explicitly set
    if (process.env.OPENCLAW_GATEWAY_TOKEN) {
        _gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        return _gatewayToken;
    }
    // Read from openclaw.json config
    try {
        const configPath = path.join(process.env.HOME || "/tmp", ".openclaw", "openclaw.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        _gatewayToken = config?.gateway?.auth?.token || null;
        if (_gatewayToken) {
            console.error("[Subprocess] Resolved gateway token from openclaw.json");
        }
    }
    catch (err) {
        console.error("[Subprocess] Failed to read gateway token:", err.message);
        _gatewayToken = null;
    }
    return _gatewayToken;
}
// Activity watchdog: if the CLI emits nothing on stdout *or* stderr for
// this many milliseconds, we assume it is wedged and SIGTERM it. The default
// is 10 minutes; tune via env for unusually long-running tools.
const DEFAULT_ACTIVITY_TIMEOUT = 600_000;
const ACTIVITY_TIMEOUT = (() => {
    const raw = process.env.CLAUDE_PROXY_ACTIVITY_TIMEOUT_MS;
    if (!raw)
        return DEFAULT_ACTIVITY_TIMEOUT;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACTIVITY_TIMEOUT;
})();
export class ClaudeSubprocess extends EventEmitter {
    process = null;
    buffer = "";
    timeoutId = null;
    activityTimeout = ACTIVITY_TIMEOUT;
    isKilled = false;
    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    async start(prompt, options) {
        const args = this.buildArgs(options);
        // Inline the system prompt into stdin instead of passing it via
        // --system-prompt. The OpenClaw system prompt can exceed 150 KB,
        // which blows past Linux ARG_MAX (~128 KiB) and causes spawn E2BIG.
        // Claude reliably follows instructions placed at the top of the
        // user message inside a labeled block.
        //
        // Because we no longer use --system-prompt, Claude Code's built-in
        // system prompt is still in effect. The override banner tells the
        // model that anything inside the [System Instructions] block takes
        // precedence over default Claude Code behavior, so OpenClaw rules
        // (e.g. "always reply in Chinese", "never use Bash for X") still
        // win when they conflict with the default agent behavior.
        const stdinPayload = options.systemPrompt
            ? `[System Instructions]\nThe rules in this block override any default Claude Code behavior. When they conflict with built-in defaults, follow these rules.\n\n${options.systemPrompt}\n[End System Instructions]\n\n${prompt}`
            : prompt;
        // Build the env we'll hand to spawn separately so we can measure it.
        const childEnv = {
            ...process.env,
            CLAUDECODE: undefined,
            // Ensure oc-tool is findable and can reach the gateway
            PATH: [
                path.join(process.env.HOME || "/tmp", ".openclaw", "bin"),
                process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            ].join(":"),
            OPENCLAW_GATEWAY_TOKEN: resolveGatewayToken() ?? undefined,
            OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789",
        };
        // Diagnostics: log argv + envp sizes so we can spot ARG_MAX (E2BIG) blowups.
        // Linux ARG_MAX is typically 128 KiB and counts argv + envp combined.
        const argvBytes = args.reduce((sum, a) => sum + Buffer.byteLength(a, "utf8") + 1, Buffer.byteLength("claude", "utf8") + 1);
        const envpBytes = Object.entries(childEnv).reduce((sum, [k, v]) => {
            if (v === undefined)
                return sum;
            return sum + Buffer.byteLength(`${k}=${v}`, "utf8") + 1;
        }, 0);
        const promptBytes = Buffer.byteLength(prompt, "utf8");
        const sysPromptBytes = options.systemPrompt
            ? Buffer.byteLength(options.systemPrompt, "utf8")
            : 0;
        const stdinBytes = Buffer.byteLength(stdinPayload, "utf8");
        console.error(`[Subprocess] argv=${argvBytes}B envp=${envpBytes}B (sum=${argvBytes + envpBytes}B) ` +
            `stdin=${stdinBytes}B (prompt=${promptBytes}B systemPrompt=${sysPromptBytes}B)`);
        return new Promise((resolve, reject) => {
            // Settle once: we either resolve on the spawn handshake or reject
            // on a spawn error, but never both. After the start() promise has
            // resolved, any further child errors are surfaced as ClaudeSubprocess
            // 'error' events instead so consumers can handle them in-stream.
            let settled = false;
            const wrapSpawnError = (err) => err.message.includes("ENOENT")
                ? new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code")
                : err;
            try {
                // Use spawn() for security - no shell interpretation
                this.process = spawn("claude", args, {
                    cwd: options.cwd || PROXY_CWD,
                    env: childEnv,
                    stdio: ["pipe", "pipe", "pipe"],
                });
                // Set activity timeout (resets on each stdout data)
                this.activityTimeout = ACTIVITY_TIMEOUT;
                this.resetActivityTimeout();
                // The 'spawn' event fires once the child has actually been
                // forked. Defer resolving start() until then so async spawn
                // errors (e.g. ENOENT) reach the caller as a real rejection
                // instead of being silently swallowed by an already-resolved
                // promise.
                this.process.once("spawn", () => {
                    if (settled)
                        return;
                    settled = true;
                    console.error(`[Subprocess] Process spawned with PID: ${this.process?.pid} (${stdinBytes} bytes via stdin)`);
                    resolve();
                });
                // Handle child errors. Before the start() promise has settled,
                // surface them as a rejection so the HTTP layer can produce a
                // proper 5xx. After settling, re-emit them so streaming
                // consumers can react in-band.
                this.process.on("error", (err) => {
                    const wrapped = wrapSpawnError(err);
                    if (!settled) {
                        settled = true;
                        this.clearTimeout();
                        reject(wrapped);
                    }
                    else {
                        this.emit("error", wrapped);
                    }
                });
                // Pipe the prompt (and inlined system prompt) via stdin instead
                // of argv to avoid E2BIG. Linux execve ARG_MAX is ~128 KiB and
                // counts argv + envp combined; OpenClaw conversations + system
                // prompts routinely exceed that on the command line.
                const stdin = this.process.stdin;
                if (stdin) {
                    stdin.on("error", (err) => {
                        console.error("[Subprocess] stdin error:", err.message);
                    });
                    stdin.end(stdinPayload, "utf8");
                }
                // Parse JSON stream from stdout
                this.process.stdout?.on("data", (chunk) => {
                    const data = chunk.toString();
                    console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
                    // Reset activity timeout — CLI is still producing output
                    this.resetActivityTimeout();
                    this.buffer += data;
                    this.processBuffer();
                });
                // Capture stderr for debugging. stderr output also counts as
                // activity — if the CLI is producing progress logs (or even
                // tool execution traces) on stderr while waiting on something
                // expensive, we should not kill it just because stdout is idle.
                this.process.stderr?.on("data", (chunk) => {
                    this.resetActivityTimeout();
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        console.error("[Subprocess stderr]:", errorText.slice(0, 500));
                    }
                });
                // Handle process close
                this.process.on("close", (code) => {
                    console.error(`[Subprocess] Process closed with code: ${code}`);
                    this.clearTimeout();
                    // Process any remaining buffer
                    if (this.buffer.trim()) {
                        this.processBuffer();
                    }
                    this.emit("close", code);
                });
            }
            catch (err) {
                // Synchronous spawn failures (e.g. EACCES, E2BIG) end up here.
                if (!settled) {
                    settled = true;
                    this.clearTimeout();
                    reject(err);
                }
            }
        });
    }
    /**
     * Build CLI arguments array.
     *
     * Note: neither the user prompt nor the system prompt is passed as argv —
     * both are piped via stdin in start() (system prompt inlined as a labeled
     * block at the top) to avoid E2BIG on long conversation histories or huge
     * OpenClaw system prompts. claude --print reads stdin when no positional
     * prompt is given.
     */
    buildArgs(options) {
        return [
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model",
            options.model,
            "--dangerously-skip-permissions",
        ];
    }
    /**
     * Process the buffer and emit parsed messages
     */
    processBuffer() {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                this.emit("message", message);
                if (isContentDelta(message)) {
                    this.emit("content_delta", message);
                }
                else if (isAssistantMessage(message)) {
                    this.emit("assistant", message);
                }
                else if (isResultMessage(message)) {
                    this.emit("result", message);
                }
            }
            catch {
                // Non-JSON output, emit as raw
                this.emit("raw", trimmed);
            }
        }
    }
    /**
     * Reset activity timeout — called on each stdout data chunk.
     * If CLI goes silent for ACTIVITY_TIMEOUT ms, we kill it.
     */
    resetActivityTimeout() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }
        this.timeoutId = setTimeout(() => {
            if (!this.isKilled) {
                this.isKilled = true;
                this.process?.kill("SIGTERM");
                this.emit("error", new Error(`Request timed out — no output for ${this.activityTimeout / 1000}s (activity timeout)`));
            }
        }, this.activityTimeout);
    }
    /**
     * Clear all timeout timers
     */
    clearTimeout() {
        if (this.timeoutId) {
            globalThis.clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
    /**
     * Kill the subprocess
     */
    kill(signal = "SIGTERM") {
        if (!this.isKilled && this.process) {
            this.isKilled = true;
            this.clearTimeout();
            this.process.kill(signal);
        }
    }
    /**
     * Check if the process is still running
     */
    isRunning() {
        return (this.process !== null &&
            !this.isKilled &&
            this.process.exitCode === null);
    }
}
/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude() {
    return new Promise((resolve) => {
        const proc = spawn("claude", ["--version"], { stdio: "pipe" });
        let output = "";
        proc.stdout?.on("data", (chunk) => {
            output += chunk.toString();
        });
        proc.on("error", () => {
            resolve({
                ok: false,
                error: "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
            });
        });
        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ ok: true, version: output.trim() });
            }
            else {
                resolve({
                    ok: false,
                    error: "Claude CLI returned non-zero exit code",
                });
            }
        });
    });
}
/**
 * Check if Claude CLI is authenticated.
 * Note: Real auth errors are detected at runtime in routes.ts (isAuthError).
 * This startup check verifies basic CLI availability only — a full API-call
 * check would slow down server start and may hang.
 */
export async function verifyAuth() {
    return { ok: true };
}
//# sourceMappingURL=manager.js.map