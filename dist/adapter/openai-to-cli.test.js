/**
 * Unit tests for the OpenAI → Claude CLI adapter pure functions.
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractModel, messagesToPrompt, stripAssistantBleed, } from "./openai-to-cli.js";
// ── extractModel ───────────────────────────────────────────────────
test("extractModel: bare aliases pass through", () => {
    assert.equal(extractModel("opus"), "opus");
    assert.equal(extractModel("sonnet"), "sonnet");
    assert.equal(extractModel("haiku"), "haiku");
});
test("extractModel: provider prefix is stripped before lookup", () => {
    assert.equal(extractModel("maxproxy/claude-opus-4"), "opus");
    assert.equal(extractModel("claude-code-cli/claude-sonnet-4-6"), "sonnet");
});
test("extractModel: opus minor versions resolve to dated names", () => {
    assert.equal(extractModel("claude-opus-4-5"), "claude-opus-4-5-20251101");
    assert.equal(extractModel("claude-opus-4-1"), "claude-opus-4-1-20250805");
    assert.equal(extractModel("claude-opus-4-0"), "claude-opus-4-20250514");
});
test("extractModel: sonnet variants collapse to alias", () => {
    assert.equal(extractModel("claude-sonnet-4"), "sonnet");
    assert.equal(extractModel("claude-sonnet-4-5"), "sonnet");
});
test("extractModel: empty / unknown defaults to opus", () => {
    assert.equal(extractModel(""), "opus");
    assert.equal(extractModel("gpt-4o"), "opus");
});
// ── stripAssistantBleed ────────────────────────────────────────────
test("stripAssistantBleed: cuts at first \\n[User] sentinel", () => {
    const input = "Here is the answer.\n[User]\nNext turn?";
    assert.equal(stripAssistantBleed(input), "Here is the answer.");
});
test("stripAssistantBleed: handles \\nHuman: legacy format", () => {
    const input = "Done.\nHuman: another question";
    assert.equal(stripAssistantBleed(input), "Done.");
});
test("stripAssistantBleed: leaves clean text untouched", () => {
    const input = "Just a normal reply with no sentinels.";
    assert.equal(stripAssistantBleed(input), input);
});
test("stripAssistantBleed: cuts at the earliest sentinel when multiple appear", () => {
    const input = "ok\nHuman: q1\n[User]\nq2";
    assert.equal(stripAssistantBleed(input), "ok");
});
// ── messagesToPrompt ───────────────────────────────────────────────
test("messagesToPrompt: renders user/assistant turns with [User]/[Assistant] tags", () => {
    const prompt = messagesToPrompt([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "Why?" },
    ]);
    assert.match(prompt, /\[User\]\nHello/);
    assert.match(prompt, /\[Assistant\]\nHi there/);
    assert.match(prompt, /\[User\]\nWhy\?$/);
});
test("messagesToPrompt: drops NO_REPLY assistant messages", () => {
    const prompt = messagesToPrompt([
        { role: "user", content: "ping" },
        { role: "assistant", content: "NO_REPLY" },
        { role: "user", content: "are you there?" },
    ]);
    assert.doesNotMatch(prompt, /NO_REPLY/);
    assert.match(prompt, /are you there\?/);
});
test("messagesToPrompt: array content of {type:'text'} blocks is flattened", () => {
    const prompt = messagesToPrompt([
        {
            role: "user",
            content: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
            ],
        },
    ]);
    assert.match(prompt, /\[User\]\nfirst\nsecond/);
});
test("messagesToPrompt: truncates oldest history when over byte budget", () => {
    // Force the smallest possible budget for this test by overriding the env
    // var BEFORE re-importing? We can't easily do that with a static import.
    // Instead, build a 200 KiB conversation and assume the default 100 KiB
    // budget kicks in.
    const big = "x".repeat(20_000);
    const messages = Array.from({ length: 8 }, (_, i) => ({
        role: "user",
        content: `turn ${i}: ${big}`,
    }));
    // Final message we expect to always survive
    messages.push({ role: "user", content: "FINAL_MARKER" });
    const prompt = messagesToPrompt(messages);
    assert.match(prompt, /FINAL_MARKER/);
    assert.match(prompt, /earlier messages truncated/);
    // The very first turn (turn 0) should have been dropped
    assert.doesNotMatch(prompt, /turn 0:/);
});
//# sourceMappingURL=openai-to-cli.test.js.map