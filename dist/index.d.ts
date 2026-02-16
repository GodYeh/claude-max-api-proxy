/**
 * Claude Code CLI Provider Plugin for OpenAI-compatible client
 *
 * Enables using Claude Max subscription through Claude Code CLI,
 * bypassing OAuth token scope restrictions.
 */
/**
 * Plugin definition
 */
declare const claudeCodeCliPlugin: {
    id: string;
    name: string;
    description: string;
    configSchema: {
        type: "object";
        properties: {};
        additionalProperties: boolean;
    };
    register(api: any): void;
};
export default claudeCodeCliPlugin;
export { startServer, stopServer, getServer } from "./server/index.js";
export { ClaudeSubprocess, verifyClaude, verifyAuth } from "./subprocess/manager.js";
export { sessionManager } from "./session/manager.js";
