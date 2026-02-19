/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */
import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";
/**
 * Create a final "done" chunk for streaming
 */
export declare function createDoneChunk(requestId: string, model: string): OpenAIChatChunk;
/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export declare function cliResultToOpenai(result: ClaudeCliResult, requestId: string): OpenAIChatResponse;
//# sourceMappingURL=cli-to-openai.d.ts.map