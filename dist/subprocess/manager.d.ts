/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */
import { EventEmitter } from "events";
import type { ClaudeCliMessage, ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
export interface SubprocessOptions {
    model: ClaudeModel;
    sessionId?: string;
    cwd?: string;
    timeout?: number;
}
export interface SubprocessEvents {
    message: (msg: ClaudeCliMessage) => void;
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
    private isKilled;
    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    start(prompt: string, options: SubprocessOptions): Promise<void>;
    /**
     * Build CLI arguments array
     */
    private buildArgs;
    /**
     * Process the buffer and emit parsed messages
     */
    private processBuffer;
    /**
     * Clear the timeout timer
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
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export declare function verifyAuth(): Promise<{
    ok: boolean;
    error?: string;
}>;
