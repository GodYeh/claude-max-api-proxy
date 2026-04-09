/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import type { OpenAIChatRequest, OpenAIChatMessage, OpenAITool } from "../types/openai.js";
export type ClaudeModel = "opus" | "sonnet" | "haiku" | string;
export interface CliInput {
    prompt: string;
    model: ClaudeModel;
    systemPrompt: string | null;
}
/**
 * Extract Claude CLI --model value from request model string.
 * Strips provider prefixes (maxproxy/, claude-code-cli/) before lookup.
 * Falls back to "opus" for unrecognized models.
 */
export declare function extractModel(model: string): ClaudeModel;
/**
 * Extract system prompt from messages (returned separately for --system-prompt flag).
 * Sanitizes OpenClaw's NO_REPLY/Heartbeat/Tooling directives, then appends
 * CLI tool instructions. If external tools are provided, also injects their schema.
 */
export declare function extractSystemPrompt(messages: OpenAIChatMessage[], tools?: OpenAITool[]): string | null;
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI.
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * System messages are extracted separately (see extractSystemPrompt). XML tool
 * patterns in assistant messages are cleaned by cleanAssistantContent() to
 * prevent the model from mimicking XML format instead of using native tools.
 * NO_REPLY assistant messages are filtered out (OpenClaw silent reply tokens).
 *
 * If the rendered prompt exceeds PROMPT_BUDGET_BYTES, the oldest messages
 * are dropped (the most recent message is always retained) and a truncation
 * marker is prepended.
 *
 * @param hasExternalTools - When true, assistant messages with tool_calls are
 *   rendered as <tool_call> markers (for multi-turn tool conversations), and
 *   tool role messages (tool results) are rendered as [Tool Result:] blocks.
 *   When false, both are skipped (CLI handles tools internally).
 */
export declare function messagesToPrompt(messages: OpenAIChatMessage[], hasExternalTools?: boolean): string;
/**
 * The conversation format uses [User] / [Assistant] tags.
 * If Claude doesn't stop cleanly, it may generate a continuation
 * that starts with "\n[User]\n" — bleeding the next human turn's
 * metadata into the assistant response.
 *
 * This strips everything from the first occurrence of "\n[User]"
 * onward, preventing metadata leakage into delivered messages.
 *
 * Also handles "\nHuman:" (legacy format) and
 * "\n[Human]" (alternative format) for robustness.
 */
export declare function stripAssistantBleed(text: string): string;
/**
 * Convert OpenAI chat request to CLI input format
 */
export declare function openaiToCli(request: OpenAIChatRequest): CliInput;
//# sourceMappingURL=openai-to-cli.d.ts.map