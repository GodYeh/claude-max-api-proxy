/**
 * Types for Claude Code CLI JSON streaming output
 * Based on research from PROTOCOL.md
 */
export function isAssistantMessage(msg) {
    return msg.type === "assistant";
}
export function isResultMessage(msg) {
    return msg.type === "result";
}
export function isContentDelta(msg) {
    return msg.type === "stream_event" && msg.event.type === "content_block_delta";
}
//# sourceMappingURL=claude-cli.js.map