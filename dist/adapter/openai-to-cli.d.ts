/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import type { OpenAIChatRequest } from "../types/openai.js";
export type ClaudeModel = "opus" | "sonnet" | "haiku";
export interface CliInput {
    prompt: string;
    model: ClaudeModel;
    sessionId?: string;
}
/**
 * Extract Claude model alias from request model string
 */
export declare function extractModel(model: string): ClaudeModel;
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export declare function messagesToPrompt(messages: OpenAIChatRequest["messages"]): string;
/**
 * Convert OpenAI chat request to CLI input format
 */
export declare function openaiToCli(request: OpenAIChatRequest): CliInput;
