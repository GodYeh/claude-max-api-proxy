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
// Spawn Claude CLI subprocesses from $HOME so that Claude Code's
// project-scoped settings hierarchy resolves the user's
// ~/.claude/settings.local.json allowlist. Spawning from any other
// directory (including ~/.openclaw/workspace) makes Claude Code look
// for a non-existent project-local settings file and fall back to
// ~/.claude/settings.json — which typically has no permissions section,
// causing every Bash invocation to be gated. See incident notes
// 2026-04-07: Apr 3 Claude CLI release tightened the settings lookup
// to project-root-only, which broke proxy-spawned subprocesses.
const PROXY_CWD = process.env.HOME || "/tmp";
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
const ACTIVITY_TIMEOUT = 600_000; // 10 minutes (no stdout activity = stuck)
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
        const args = this.buildArgs(prompt, options);
        return new Promise((resolve, reject) => {
            try {
                // Use spawn() for security - no shell interpretation
                this.process = spawn("claude", args, {
                    cwd: options.cwd || PROXY_CWD,
                    env: {
                        ...process.env,
                        CLAUDECODE: undefined,
                        // Ensure oc-tool is findable and can reach the gateway
                        PATH: [
                            path.join(process.env.HOME || "/tmp", ".openclaw", "bin"),
                            process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
                        ].join(":"),
                        OPENCLAW_GATEWAY_TOKEN: resolveGatewayToken() ?? undefined,
                        OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789",
                    },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                // Set activity timeout (resets on each stdout data)
                this.activityTimeout = ACTIVITY_TIMEOUT;
                this.resetActivityTimeout();
                // Handle spawn errors (e.g., claude not found)
                this.process.on("error", (err) => {
                    this.clearTimeout();
                    if (err.message.includes("ENOENT")) {
                        reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
                    }
                    else {
                        reject(err);
                    }
                });
                // Close stdin since we pass prompt as argument
                this.process.stdin?.end();
                console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
                // Parse JSON stream from stdout
                this.process.stdout?.on("data", (chunk) => {
                    const data = chunk.toString();
                    console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
                    // Reset activity timeout — CLI is still producing output
                    this.resetActivityTimeout();
                    this.buffer += data;
                    this.processBuffer();
                });
                // Capture stderr for debugging
                this.process.stderr?.on("data", (chunk) => {
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
                // Resolve immediately since we're streaming
                resolve();
            }
            catch (err) {
                this.clearTimeout();
                reject(err);
            }
        });
    }
    /**
     * Build CLI arguments array
     */
    buildArgs(prompt, options) {
        const args = [
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model",
            options.model,
            "--dangerously-skip-permissions",
        ];
        // Pass system prompt as a native CLI flag
        if (options.systemPrompt) {
            args.push("--system-prompt", options.systemPrompt);
        }
        args.push("--", prompt);
        return args;
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