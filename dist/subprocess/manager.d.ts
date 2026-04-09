import { EventEmitter } from "events";
import type { ClaudeCliMessage, ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
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
export declare class ClaudeSubprocess extends EventEmitter {
    private process;
    private buffer;
    private timeoutId;
    private activityTimeout;
    private isKilled;
    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    start(prompt: string, options: SubprocessOptions): Promise<void>;
    /**
     * Build CLI arguments array.
     *
     * Note: neither the user prompt nor the system prompt is passed as argv —
     * both are piped via stdin in start() (system prompt inlined as a labeled
     * block at the top) to avoid E2BIG on long conversation histories or huge
     * OpenClaw system prompts. claude --print reads stdin when no positional
     * prompt is given.
     */
    private buildArgs;
    /**
     * Process the buffer and emit parsed messages
     */
    private processBuffer;
    /**
     * Reset activity timeout — called on each stdout data chunk.
     * If CLI goes silent for ACTIVITY_TIMEOUT ms, we kill it.
     */
    private resetActivityTimeout;
    /**
     * Clear all timeout timers
     */
    private clearTimeout;
    /**
     * Kill the subprocess
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * Check if the process is still running
     */
    isRunning(): boolean;
}
/**
 * Verify that Claude CLI is installed and accessible
 */
export declare function verifyClaude(): Promise<{
    ok: boolean;
    error?: string;
    version?: string;
}>;
/**
 * Check if Claude CLI is authenticated.
 * Note: Real auth errors are detected at runtime in routes.ts (isAuthError).
 * This startup check verifies basic CLI availability only — a full API-call
 * check would slow down server start and may hang.
 */
export declare function verifyAuth(): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=manager.d.ts.map