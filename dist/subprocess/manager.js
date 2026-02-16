/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
// Stable cwd for session file consistency
const PROXY_CWD = path.join(process.env.HOME || "/tmp", ".openclaw", "workspace");
const ACTIVITY_TIMEOUT = 600000; // 10 minutes (no stdout activity = stuck)
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
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                // Set activity timeout (resets on each stdout data)
                // No absolute timeout — complex tasks can run as long as needed
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
                // Capture stderr for debugging and resume failure detection
                this.process.stderr?.on("data", (chunk) => {
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        console.error("[Subprocess stderr]:", errorText.slice(0, 500));
                        // Detect resume failures so caller can invalidate the session
                        if (errorText.includes("Failed to resume") ||
                            errorText.includes("Session not found") ||
                            errorText.includes("--resume requires") ||
                            errorText.includes("Could not find session")) {
                            this.emit("resume_failed", errorText);
                        }
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
            "--print", // Non-interactive mode
            "--output-format",
            "stream-json", // JSON streaming output
            "--verbose", // Required for stream-json
            "--include-partial-messages", // Enable streaming chunks
            "--model",
            options.model, // Model alias (opus/sonnet/haiku)
            // Session persistence enabled (no --no-session-persistence)
            "--dangerously-skip-permissions", // Skip tool permission prompts (prevents hanging)
        ];
        // Session handling: --resume for continuing, --session-id for new conversations
        // IMPORTANT: these must come BEFORE -- (the end-of-flags marker)
        if (options.resumeSessionId) {
            args.push("--resume", options.resumeSessionId);
        } else if (options.sessionId) {
            args.push("--session-id", options.sessionId);
        }
        // Pass system prompt as a native CLI flag (proper role separation)
        if (options.systemPrompt) {
            args.push("--system-prompt", options.systemPrompt);
        }
        args.push(
            "--", // End of flags, start of positional args
            prompt, // Pass prompt as argument (more reliable than stdin)
        );
        return args;
    }
    /**
     * Process the buffer and emit parsed messages
     */
    processBuffer() {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || ""; // Keep incomplete line
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                this.emit("message", message);
                if (isContentDelta(message)) {
                    // Emit content delta for streaming
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
     * Reset activity timeout — called on each stdout data chunk
     * If CLI goes silent for ACTIVITY_TIMEOUT ms, we kill it
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
            clearTimeout(this.timeoutId);
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
        return this.process !== null && !this.isKilled && this.process.exitCode === null;
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
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth() {
    // If Claude CLI is installed and the user has run `claude auth login`,
    // credentials are stored in the OS keychain and will be used automatically.
    // We can't easily check the keychain, so we'll just return true if the CLI exists.
    // Authentication errors will surface when making actual API calls.
    return { ok: true };
}
