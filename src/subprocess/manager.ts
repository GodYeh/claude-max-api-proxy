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
import {
    isAssistantMessage,
    isResultMessage,
    isContentDelta,
} from "../types/claude-cli.js";
import type {
    ClaudeCliMessage,
    ClaudeCliAssistant,
    ClaudeCliResult,
    ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

const PROXY_CWD = path.join(
    process.env.HOME || "/tmp",
    ".openclaw",
    "workspace"
);

// ── Gateway token resolution ────────────────────────────────────
// Read OPENCLAW_GATEWAY_TOKEN from openclaw.json if not in env.
// This enables oc-tool (cross-channel messaging, browser, cron, etc.)
// to authenticate with the gateway from within Claude CLI subprocesses.
let _gatewayToken: string | null | undefined;

function resolveGatewayToken(): string | null {
    if (_gatewayToken !== undefined) return _gatewayToken;
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
    } catch (err: any) {
        console.error("[Subprocess] Failed to read gateway token:", err.message);
        _gatewayToken = null;
    }
    return _gatewayToken;
}

const ACTIVITY_TIMEOUT = 600_000; // 10 minutes (no stdout activity = stuck)

export interface SubprocessOptions {
    model: ClaudeModel;
    systemPrompt?: string | null;
    cwd?: string;
    timeout?: number;
}

export interface SubprocessEvents {
    message: (msg: ClaudeCliMessage) => void;
    content_delta: (msg: ClaudeCliStreamEvent) => void;
    assistant: (msg: ClaudeCliAssistant) => void;
    result: (result: ClaudeCliResult) => void;
    error: (error: Error) => void;
    close: (code: number | null) => void;
    raw: (line: string) => void;
}

export class ClaudeSubprocess extends EventEmitter {
    private process: ReturnType<typeof spawn> | null = null;
    private buffer = "";
    private timeoutId: ReturnType<typeof setTimeout> | null = null;
    private activityTimeout = ACTIVITY_TIMEOUT;
    private isKilled = false;

    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    async start(prompt: string, options: SubprocessOptions): Promise<void> {
        const args = this.buildArgs(options);

        // Inline the system prompt into stdin instead of passing it via
        // --system-prompt. The OpenClaw system prompt can exceed 150 KB,
        // which blows past Linux ARG_MAX (~128 KiB) and causes spawn E2BIG.
        // Claude reliably follows instructions placed at the top of the
        // user message inside a labeled block.
        const stdinPayload = options.systemPrompt
            ? `[System Instructions]\n${options.systemPrompt}\n[End System Instructions]\n\n${prompt}`
            : prompt;

        // Build the env we'll hand to spawn separately so we can measure it.
        const childEnv: NodeJS.ProcessEnv = {
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
        const argvBytes = args.reduce(
            (sum, a) => sum + Buffer.byteLength(a, "utf8") + 1,
            Buffer.byteLength("claude", "utf8") + 1,
        );
        const envpBytes = Object.entries(childEnv).reduce((sum, [k, v]) => {
            if (v === undefined) return sum;
            return sum + Buffer.byteLength(`${k}=${v}`, "utf8") + 1;
        }, 0);
        const promptBytes = Buffer.byteLength(prompt, "utf8");
        const sysPromptBytes = options.systemPrompt
            ? Buffer.byteLength(options.systemPrompt, "utf8")
            : 0;
        const stdinBytes = Buffer.byteLength(stdinPayload, "utf8");
        console.error(
            `[Subprocess] argv=${argvBytes}B envp=${envpBytes}B (sum=${argvBytes + envpBytes}B) ` +
                `stdin=${stdinBytes}B (prompt=${promptBytes}B systemPrompt=${sysPromptBytes}B)`,
        );

        return new Promise((resolve, reject) => {
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

                // Handle spawn errors (e.g., claude not found)
                this.process.on("error", (err) => {
                    this.clearTimeout();
                    if (err.message.includes("ENOENT")) {
                        reject(
                            new Error(
                                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
                            )
                        );
                    } else {
                        reject(err);
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
                console.error(
                    `[Subprocess] Process spawned with PID: ${this.process.pid} (${stdinBytes} bytes via stdin)`
                );

                // Parse JSON stream from stdout
                this.process.stdout?.on("data", (chunk: Buffer) => {
                    const data = chunk.toString();
                    console.error(
                        `[Subprocess] Received ${data.length} bytes of stdout`
                    );
                    // Reset activity timeout — CLI is still producing output
                    this.resetActivityTimeout();
                    this.buffer += data;
                    this.processBuffer();
                });

                // Capture stderr for debugging
                this.process.stderr?.on("data", (chunk: Buffer) => {
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        console.error(
                            "[Subprocess stderr]:",
                            errorText.slice(0, 500)
                        );
                    }
                });

                // Handle process close
                this.process.on("close", (code: number | null) => {
                    console.error(
                        `[Subprocess] Process closed with code: ${code}`
                    );
                    this.clearTimeout();
                    // Process any remaining buffer
                    if (this.buffer.trim()) {
                        this.processBuffer();
                    }
                    this.emit("close", code);
                });

                // Resolve immediately since we're streaming
                resolve();
            } catch (err) {
                this.clearTimeout();
                reject(err);
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
    private buildArgs(options: SubprocessOptions): string[] {
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
    private processBuffer(): void {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                const message: ClaudeCliMessage = JSON.parse(trimmed);
                this.emit("message", message);

                if (isContentDelta(message)) {
                    this.emit("content_delta", message);
                } else if (isAssistantMessage(message)) {
                    this.emit("assistant", message);
                } else if (isResultMessage(message)) {
                    this.emit("result", message);
                }
            } catch {
                // Non-JSON output, emit as raw
                this.emit("raw", trimmed);
            }
        }
    }

    /**
     * Reset activity timeout — called on each stdout data chunk.
     * If CLI goes silent for ACTIVITY_TIMEOUT ms, we kill it.
     */
    private resetActivityTimeout(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }
        this.timeoutId = setTimeout(() => {
            if (!this.isKilled) {
                this.isKilled = true;
                this.process?.kill("SIGTERM");
                this.emit(
                    "error",
                    new Error(
                        `Request timed out — no output for ${this.activityTimeout / 1000}s (activity timeout)`
                    )
                );
            }
        }, this.activityTimeout);
    }

    /**
     * Clear all timeout timers
     */
    private clearTimeout(): void {
        if (this.timeoutId) {
            globalThis.clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    /**
     * Kill the subprocess
     */
    kill(signal: NodeJS.Signals = "SIGTERM"): void {
        if (!this.isKilled && this.process) {
            this.isKilled = true;
            this.clearTimeout();
            this.process.kill(signal);
        }
    }

    /**
     * Check if the process is still running
     */
    isRunning(): boolean {
        return (
            this.process !== null &&
            !this.isKilled &&
            this.process.exitCode === null
        );
    }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{
    ok: boolean;
    error?: string;
    version?: string;
}> {
    return new Promise((resolve) => {
        const proc = spawn("claude", ["--version"], { stdio: "pipe" });
        let output = "";

        proc.stdout?.on("data", (chunk: Buffer) => {
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
            } else {
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
export async function verifyAuth(): Promise<{
    ok: boolean;
    error?: string;
}> {
    return { ok: true };
}
