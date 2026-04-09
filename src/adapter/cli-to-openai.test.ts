/**
 * Unit tests for the Claude CLI → OpenAI adapter pure functions.
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCalls } from "./cli-to-openai.js";

test("parseToolCalls: extracts a single well-formed tool call", () => {
    const text = `prelude\n<tool_call>{"id":"call_1","name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>\ntrailer`;
    const result = parseToolCalls(text);
    assert.equal(result.hasToolCalls, true);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, "call_1");
    assert.equal(result.toolCalls[0].function.name, "get_weather");
    // arguments must be a JSON string per OpenAI spec
    assert.equal(typeof result.toolCalls[0].function.arguments, "string");
    assert.equal(result.toolCalls[0].function.arguments, '{"city":"Tokyo"}');
});

test("parseToolCalls: extracts multiple tool calls in order", () => {
    const text =
        `<tool_call>{"id":"call_a","name":"a","arguments":{}}</tool_call>` +
        `\n<tool_call>{"id":"call_b","name":"b","arguments":{"x":1}}</tool_call>`;
    const result = parseToolCalls(text);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].id, "call_a");
    assert.equal(result.toolCalls[1].id, "call_b");
    assert.equal(result.toolCalls[1].function.arguments, '{"x":1}');
});

test("parseToolCalls: arguments already as a string is preserved verbatim", () => {
    const text = `<tool_call>{"id":"call_1","name":"a","arguments":"{\\"raw\\":true}"}</tool_call>`;
    const result = parseToolCalls(text);
    assert.equal(result.toolCalls[0].function.arguments, '{"raw":true}');
});

test("parseToolCalls: ignores malformed JSON inside tool_call without crashing", () => {
    const text = `<tool_call>not actually json</tool_call> trailing prose`;
    const result = parseToolCalls(text);
    // Malformed call is silently dropped, but the surrounding text still loses the marker
    assert.equal(result.hasToolCalls, false);
    assert.equal(result.textWithoutToolCalls, "trailing prose");
});

test("parseToolCalls: text without markers passes through unchanged", () => {
    const text = "Just a normal answer.";
    const result = parseToolCalls(text);
    assert.equal(result.hasToolCalls, false);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.textWithoutToolCalls, "Just a normal answer.");
});

test("parseToolCalls: concurrent invocations do not share state", () => {
    // Regression for the previous module-level /g RegExp lastIndex bug.
    // Run a long parse and a short parse interleaved and check both finish
    // with the right results.
    const longText = `<tool_call>{"id":"long","name":"l","arguments":{"k":"${"v".repeat(1000)}"}}</tool_call>`;
    const shortText = `<tool_call>{"id":"short","name":"s","arguments":{}}</tool_call>`;
    const a = parseToolCalls(longText);
    const b = parseToolCalls(shortText);
    const c = parseToolCalls(longText);
    assert.equal(a.toolCalls[0].id, "long");
    assert.equal(b.toolCalls[0].id, "short");
    assert.equal(c.toolCalls[0].id, "long");
});
