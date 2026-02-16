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
export function isStreamEvent(msg) {
    return msg.type === "stream_event";
}
export function isContentDelta(msg) {
    return isStreamEvent(msg) && msg.event.type === "content_block_delta";
}
export function isSystemInit(msg) {
    return msg.type === "system" && msg.subtype === "init";
}
