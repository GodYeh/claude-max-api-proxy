/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */
import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";
/**
 * Extract text content from Claude CLI assistant message
 */
export declare function extractTextContent(message: ClaudeCliAssistant): string;
/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export declare function cliToOpenaiChunk(message: ClaudeCliAssistant, requestId: string, isFirst?: boolean): OpenAIChatChunk;
/**
 * Create a final "done" chunk for streaming
 */
export declare function createDoneChunk(requestId: string, model: string): OpenAIChatChunk;
/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export declare function cliResultToOpenai(result: ClaudeCliResult, requestId: string): OpenAIChatResponse;
