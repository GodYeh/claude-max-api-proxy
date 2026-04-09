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

// ─── Content extraction ────────────────────────────────────────────

/**
 * Extract plain text from message content.
 * OpenClaw gateway may send content as:
 *   - string: "hello"
 *   - array:  [{type:"text", text:"hello"}, {type:"image", ...}]
 */
function extractText(content: OpenAIChatMessage["content"]): string {
    if (content === null || content === undefined) return "";
    if (typeof content === "string") {
        // Some upstream serializers stringify null content as the literal
        // four-letter word "null". Treat that as empty so callers don't
        // need a separate guard.
        return content === "null" ? "" : content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text!)
            .join("\n");
    }
    return String(content ?? "");
}

// ─── System prompt sanitization ────────────────────────────────────

/**
 * Sanitize the OpenClaw system prompt for Claude Code CLI.
 *
 * The OpenClaw gateway generates a system prompt designed for its embedded
 * agent (Anthropic API), which includes instructions about NO_REPLY tokens,
 * HEARTBEAT_OK tokens, and tool descriptions for OpenClaw-specific tools.
 * Claude Code CLI has its own tools and doesn't understand these directives.
 *
 * When Claude CLI receives the NO_REPLY instruction ("When you have nothing
 * to say, respond with ONLY: NO_REPLY"), it often outputs "NO_REPLY" as its
 * response — which the gateway then treats as a silent reply and suppresses.
 *
 * This function strips those problematic sections while preserving the useful
 * parts (persona, workspace context, runtime info).
 */
function sanitizeSystemPrompt(prompt: string): string {
    if (!prompt) return prompt;

    // Remove the "Silent Replies" section entirely
    prompt = prompt.replace(/## Silent Replies[\s\S]*?(?=\n## |\n$|$)/, "");

    // Remove the "Heartbeats" section (HEARTBEAT_OK instructions)
    prompt = prompt.replace(/## Heartbeats[\s\S]*?(?=\n## |\n$|$)/, "");

    // Remove inline NO_REPLY references in tool descriptions
    prompt = prompt.replace(/[—–-]\s*reply with NO_REPLY[^.\n]*\./g, ".");
    prompt = prompt.replace(/respond with ONLY:\s*NO_REPLY/g, "respond normally");
    prompt = prompt.replace(/reply ONLY:\s*NO_REPLY/g, "respond normally");

    // Remove the "Tooling" section (OpenClaw tool list) — Claude CLI has its own tools
    prompt = prompt.replace(/## Tooling\nTool availability[^]*?(?=\n## )/s, "");

    // Remove inline references to NO_REPLY in messaging tool instructions
    prompt = prompt.replace(/If you use `message`[^]*?NO_REPLY[^.\n]*\./g, "");

    // Remove references about defaulting to NO_REPLY
    prompt = prompt.replace(/do not forward raw system text or default to NO_REPLY\)/g, ")");

    // Clean up multiple consecutive blank lines
    prompt = prompt.replace(/\n{4,}/g, "\n\n\n");

    return prompt.trim();
}

// ─── XML tool cleaning ─────────────────────────────────────────────

/**
 * XML tool tag names used by OpenClaw's native tool system.
 * When conversation history contains assistant messages with these XML-formatted
 * tool calls, the CLI model may mimic the format instead of using its own native
 * tool_use system. We strip these patterns to prevent confusion.
 */
const XML_TOOL_TAGS = [
    "Bash", "read", "exec", "session_status", "gateway", "canvas",
    "browser", "find", "grep", "apply_patch", "process", "ls",
    "cron", "nodes", "sessions_list", "sessions_history", "sessions_send",
    "message", "media",
];

/**
 * Clean XML tool call patterns from assistant message content.
 * OpenClaw's conversation history may contain assistant messages with XML-formatted
 * tool calls (e.g. <Bash><command>...</command></Bash>). If passed to the CLI as-is,
 * the model mimics this format instead of using native tool_use blocks.
 *
 * We replace XML tool blocks with a brief summary to preserve context without the format.
 */
function cleanAssistantContent(content: string): string {
    let cleaned = content;

    // Bash/exec: extract command for context
    cleaned = cleaned.replace(
        /<(?:Bash|exec)[>\s][\s\S]*?<command>([\s\S]*?)<\/command>[\s\S]*?<\/(?:Bash|exec)>/gi,
        (_, cmd) => `[Ran command: ${cmd.trim().substring(0, 200)}]`
    );
    // read: extract path
    cleaned = cleaned.replace(
        /<read[>\s][\s\S]*?<path>([\s\S]*?)<\/path>[\s\S]*?<\/read>/gi,
        (_, path) => `[Read file: ${path.trim()}]`
    );
    // browser: extract action
    cleaned = cleaned.replace(
        /<browser[>\s][\s\S]*?<action>([\s\S]*?)<\/action>[\s\S]*?<\/browser>/gi,
        (_, action) => `[Browser: ${action.trim()}]`
    );
    // message: extract action
    cleaned = cleaned.replace(
        /<message[>\s][\s\S]*?<action>([\s\S]*?)<\/action>[\s\S]*?<\/message>/gi,
        (_, action) => `[Message: ${action.trim()}]`
    );
    // cron, canvas, nodes, gateway, sessions_*: extract action generically
    cleaned = cleaned.replace(
        /<(cron|canvas|nodes|gateway|sessions_list|sessions_history|sessions_send|session_status)[>\s][\s\S]*?(?:<action>([\s\S]*?)<\/action>)?[\s\S]*?<\/\1>/gi,
        (_, tool, action) => `[${tool}: ${(action || 'executed').trim()}]`
    );
    // apply_patch, process, media, find, grep, ls: generic summary
    cleaned = cleaned.replace(
        /<(apply_patch|process|media|find|grep|ls)[>\s][\s\S]*?<\/\1>/gi,
        (_, tool) => `[${tool} executed]`
    );
    // Clean leftover unmatched opening tags
    cleaned = cleaned.replace(
        new RegExp(`<(${XML_TOOL_TAGS.join("|")})(\\s[^>]*)?>`, "gi"),
        (_, tool) => `[${tool}]`
    );
    // Strip <tool_call>...</tool_call> markers from history (these are text-based
    // tool calls from prior turns — summarize them to prevent format confusion)
    cleaned = cleaned.replace(
        /<tool_call>([\s\S]*?)<\/tool_call>/g,
        (_, inner) => {
            try {
                const parsed = JSON.parse(inner.trim());
                return `[tool_call: ${parsed.name || "unknown"}]`;
            } catch {
                return "[tool_call]";
            }
        }
    );
    // Collapse excessive consecutive summaries
    cleaned = cleaned.replace(/(\[[\w\s:\/._-]+\]\s*){4,}/g, (match) => {
        const items = match.trim().split('\n').filter(Boolean);
        return items.slice(0, 3).join('\n') + `\n[...and ${items.length - 3} more tool calls]\n`;
    });

    return cleaned.trim();
}

// ─── Model mapping ─────────────────────────────────────────────────

/**
 * Maps model strings from OpenClaw to Claude CLI --model values.
 *
 * CLI accepts either aliases (opus/sonnet/haiku → latest version)
 * or full model names (claude-opus-4-5-20251101 → specific version).
 */
const MODEL_MAP: Record<string, string> = {
    // Short aliases → CLI built-in aliases (always latest)
    "opus": "opus",
    "sonnet": "sonnet",
    "haiku": "haiku",

    // Opus family
    "claude-opus-4": "opus",
    "claude-opus-4-6": "opus",
    "claude-opus-4-5": "claude-opus-4-5-20251101",
    "claude-opus-4-5-20251101": "claude-opus-4-5-20251101",
    "claude-opus-4-1": "claude-opus-4-1-20250805",
    "claude-opus-4-1-20250805": "claude-opus-4-1-20250805",
    "claude-opus-4-0": "claude-opus-4-20250514",
    "claude-opus-4-20250514": "claude-opus-4-20250514",

    // Sonnet family
    "claude-sonnet-4": "sonnet",
    "claude-sonnet-4-6": "sonnet",
    "claude-sonnet-4-5": "sonnet",
    "claude-sonnet-4-5-20250929": "sonnet",
    "claude-sonnet-4-0": "claude-sonnet-4-20250514",
    "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",

    // Haiku family
    "claude-haiku-4": "haiku",
    "claude-haiku-4-5": "haiku",
    "claude-haiku-4-5-20251001": "haiku",
};

/**
 * Extract Claude CLI --model value from request model string.
 * Strips provider prefixes (maxproxy/, claude-code-cli/) before lookup.
 * Falls back to "opus" for unrecognized models.
 */
export function extractModel(model: string): ClaudeModel {
    if (!model) return "opus";

    // Try direct lookup
    if (MODEL_MAP[model]) return MODEL_MAP[model];

    // Strip provider prefixes: "maxproxy/claude-opus-4-5" → "claude-opus-4-5"
    const stripped = model.replace(/^(claude-code-cli|maxproxy)\//, "");
    if (MODEL_MAP[stripped]) return MODEL_MAP[stripped];

    // If it looks like a full Claude model name, pass it through directly
    if (stripped.startsWith("claude-")) return stripped;

    // Default to opus (Claude Max subscription)
    return "opus";
}

// ─── CLI tool instruction ──────────────────────────────────────────

/**
 * CLI tool usage instruction appended to the system prompt.
 *
 * This is the *minimum* set of rules the proxy depends on:
 *  1. Use native CLI tools, never XML stand-ins.
 *  2. Always actually transcribe audio rather than hallucinate.
 *  3. The MEDIA: / FILE: / [[…]] response directives the proxy parses.
 *  4. The 10-minute activity-timeout escape hatch.
 *  5. Final-response formatting (target language, no internal thinking).
 *
 * Detailed oc-tool subcommand usage used to be documented inline here, but
 * that bloated every request by 4-5 KiB of input tokens and was constantly
 * out of date. The model can rediscover it on demand via `oc-tool --help`
 * (and `oc-tool <subcommand> --help`), since it has Bash anyway.
 */
const CLI_TOOL_INSTRUCTION = `

## CRITICAL: Tool Usage Rules
You are running inside Claude Code CLI. You MUST use native tools for all operations.

Available tools: Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch.

Rules:
1. ALWAYS use the Bash tool to run shell commands (ffmpeg, curl, python3, etc.)
2. ALWAYS use the Read tool to read files
3. NEVER output tool calls as XML text (e.g. <Bash>, <exec>, <read>). Those are NOT executed.
4. NEVER pretend to have executed a command — actually call the tool
5. NEVER hallucinate or fabricate command output — run the actual command

## Voice/Audio Messages
When you receive a voice/audio message (indicated by [media attached: ...ogg] or <media:audio>):
- You MUST use the Bash tool to actually process the audio file
- NEVER guess or hallucinate what the user said — you CANNOT hear audio, you MUST transcribe it
- The environment variable $GROQ_API_KEY is available for Groq Whisper API calls
- Transcribe directly with: curl -s -X POST "https://api.groq.com/openai/v1/audio/transcriptions" -H "Authorization: Bearer $GROQ_API_KEY" -H "Content-Type: multipart/form-data" -F "file=@/path/to/file.ogg" -F "model=whisper-large-v3-turbo" -F "language=zh"
- If transcription fails, say so honestly — do NOT make up a transcription

## OpenClaw Platform Tools (via oc-tool in Bash)
\`oc-tool\` is on PATH. It exposes the OpenClaw platform: cross-channel
messaging (telegram/slack/discord), browser automation, cron, sessions,
TTS, web search/fetch, image analysis, and more. All arguments are JSON.

Discover usage on demand instead of guessing:
  oc-tool --help                       # list every subcommand
  oc-tool <subcommand> --help          # full syntax + examples

Common subcommand entry points:
  oc-tool browser    — navigate, snapshot, screenshot, click, type, etc.
  oc-tool message    — send/read/edit/react/pin across channels
  oc-tool cron       — list/add/update/remove/run scheduled jobs
  oc-tool sessions_* — list/history/status of conversation sessions
  oc-tool tts speak  — generate voice audio (returns MEDIA: path)
  oc-tool web_search / oc-tool web_fetch
  oc-tool image      — describe/analyze a local image file

Browser tip: always run \`oc-tool browser snapshot --interactive\` first to get
element refs (like e6, e12) before clicking/typing — never guess them.

## Sending Files and Media (CRITICAL)
To send ANY file (PDF, image, audio, etc.) to the user, you MUST include a MEDIA: line in your response.
Without MEDIA: the file will NOT be delivered — just saying "see attached" does nothing.

Rules:
- MEDIA:<absolute_path> MUST be on its own line (not glued to other text)
- Put text reply BEFORE the MEDIA: line, separated by a blank line
- For voice/audio replies: add [[audio_as_voice]] on its own line BEFORE the MEDIA: line
- For video files: use FILE:<absolute_path> instead of MEDIA:
- You can send multiple files by putting multiple MEDIA:/FILE: lines
- To reply to the user's message (threading): add [[reply_to_current]] on its own line

Examples:
  Sending a PDF report:
  報告已產出，請查收。

  MEDIA:/path/to/report.pdf

  Sending a voice reply:
  這是語音回覆。

  [[audio_as_voice]]
  MEDIA:/path/to/voice.mp3

  Sending a screenshot:
  這是截圖。

  MEDIA:/path/to/screenshot.png

  Sending multiple files:
  分析結果如下。

  MEDIA:/path/to/report.pdf
  MEDIA:/path/to/screenshot.png

  Sending a video:
  錄製完成。

  FILE:/path/to/video.mp4

- NEVER write: some text here.MEDIA:/path  (this breaks media detection)
- NEVER say "see attached PDF" without an actual MEDIA: line — the file won't be sent
- ALWAYS use absolute paths for MEDIA: and FILE:

## Special Response Directives
These tags on their own line control delivery behavior:
- [[audio_as_voice]]     — next MEDIA: audio sent as Telegram voice bubble
- [[reply_to_current]]   — reply to the triggering message (creates thread)
- HEARTBEAT_OK           — acknowledge a cron heartbeat silently (no message sent to user)

## Long-Running Commands (prevents timeout kills)
There is a 10-minute activity timeout. If a Bash command produces no stdout for 10 minutes, the process is killed.
For commands that might run silently for a long time (large downloads, heavy processing):
- Add progress output, e.g.: yt-dlp --progress --newline ...
- Or use a keepalive loop: (while true; do echo "[still running...]"; sleep 60; done) & BGPID=$!; <your_command>; kill $BGPID 2>/dev/null
- Common long commands: yt-dlp, ffmpeg, large curl uploads, pip install

## Response Format
- Your FINAL response goes directly to the user on Telegram
- Do NOT include internal thinking like "Let me check..." in your reply
- Reply in the SAME language the user used (Chinese → Chinese, English → English)
- Be concise — your entire output becomes one Telegram message`;

// ─── Tool schema serialization ─────────────────────────────────────

/**
 * Serialize OpenAI tool definitions into a prompt block that instructs
 * the model to emit <tool_call>...</tool_call> markers as text output.
 *
 * The model is told:
 *  - Exactly what format to use
 *  - That it must stop after emitting tool calls (do not add prose)
 *  - That arguments must be valid JSON objects (not strings)
 */
function serializeToolsToPrompt(tools: OpenAITool[]): string {
    const toolsJson = JSON.stringify(tools, null, 2);
    return `

## External Tools (Text-Based Tool Calling)

You have access to the following external tools. When you need to call a tool, output EXACTLY this format — one tool call per line, no surrounding markdown, no commentary before or after:

<tool_call>{"id":"call_1","name":"<function_name>","arguments":<args_as_json_object>}</tool_call>

Rules:
- id must be a unique short alphanumeric string (e.g. "call_1", "call_abc123")
- name must exactly match one of the tool names listed in the schema below
- arguments must be a valid JSON object (NOT a JSON string), matching the parameter schema
- You may output multiple tool calls, one per line
- After outputting tool calls, STOP — do not add any further text until you receive tool results
- If no tool call is needed, respond normally without any <tool_call> markers

### Tool Schema

<tools>
${toolsJson}
</tools>`;
}

// ─── Prompt conversion ─────────────────────────────────────────────

/**
 * Extract system prompt from messages (returned separately for --system-prompt flag).
 * Sanitizes OpenClaw's NO_REPLY/Heartbeat/Tooling directives, then appends
 * CLI tool instructions. If external tools are provided, also injects their schema.
 */
export function extractSystemPrompt(
    messages: OpenAIChatMessage[],
    tools?: OpenAITool[]
): string | null {
    const systemParts: string[] = [];
    for (const msg of messages) {
        if (msg.role === "system") {
            systemParts.push(extractText(msg.content));
        }
    }

    const base = systemParts.join("\n\n") || "";
    // Sanitize OpenClaw-specific directives that confuse CLI
    const sanitized = sanitizeSystemPrompt(base);
    // Append CLI tool instruction to ensure native tool usage
    let prompt = sanitized + CLI_TOOL_INSTRUCTION;
    // Append external tool schema if provided
    if (tools && tools.length > 0) {
        prompt += serializeToolsToPrompt(tools);
    }
    return prompt.trim() || null;
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * System messages are extracted separately (passed via --system-prompt flag).
 * XML tool patterns in assistant messages are cleaned by cleanAssistantContent()
 * to prevent the model from mimicking XML format instead of using native tools.
 * NO_REPLY assistant messages are filtered out (OpenClaw silent reply tokens).
 *
 * @param hasExternalTools - When true, assistant messages with tool_calls are
 *   rendered as <tool_call> markers (for multi-turn tool conversations), and
 *   tool role messages (tool results) are rendered as [Tool Result:] blocks.
 *   When false, both are skipped (CLI handles tools internally).
 */
/**
 * Default soft cap on the rendered prompt size, in UTF-8 bytes. The proxy
 * pipes the prompt via stdin so we are not bound by ARG_MAX (~128 KiB) any
 * more, but very long histories still cost input tokens linearly *and*
 * compound across every request because the gateway resends the full
 * history each turn. Cap conservatively and let the user override.
 */
const DEFAULT_PROMPT_BUDGET_BYTES = 100_000;
const PROMPT_BUDGET_BYTES = (() => {
    const raw = process.env.CLAUDE_PROXY_PROMPT_BUDGET_BYTES;
    if (!raw) return DEFAULT_PROMPT_BUDGET_BYTES;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROMPT_BUDGET_BYTES;
})();

const TRUNCATION_NOTE = "[earlier messages truncated due to length]";

/**
 * Render a single non-system message into its prompt-block string, or
 * return null if the message has nothing to contribute (NO_REPLY filler,
 * empty assistant tool_calls, ignored tool results, etc.).
 */
function renderMessage(
    msg: OpenAIChatMessage,
    hasExternalTools: boolean,
): string | null {
    const text = extractText(msg.content);

    switch (msg.role) {
        case "user":
            return `[User]\n${text}`;

        case "assistant": {
            // Skip NO_REPLY responses — OpenClaw silent tokens, not real content
            if (!text || text.trim() === "NO_REPLY") {
                if (hasExternalTools && msg.tool_calls && msg.tool_calls.length > 0) {
                    // fall through to tool-call rendering below
                } else {
                    return null;
                }
            }

            if (hasExternalTools && msg.tool_calls && msg.tool_calls.length > 0) {
                // Render prior tool calls as text markers so the model understands
                // what it previously requested (multi-turn tool conversation)
                const markers = msg.tool_calls
                    .map((tc) => {
                        const args = typeof tc.function.arguments === "string"
                            ? tc.function.arguments
                            : JSON.stringify(tc.function.arguments);
                        let argsObj: unknown;
                        try { argsObj = JSON.parse(args); } catch { argsObj = args; }
                        return `<tool_call>${JSON.stringify({
                            id: tc.id,
                            name: tc.function.name,
                            arguments: argsObj,
                        })}</tool_call>`;
                    })
                    .join("\n");
                return `[Assistant]\n${markers}`;
            }

            // Skip assistant messages that are purely tool_calls with no text
            if (msg.tool_calls && !text) return null;
            // Clean XML tool patterns to prevent CLI from mimicking them
            const cleaned = cleanAssistantContent(text);
            return cleaned ? `[Assistant]\n${cleaned}` : null;
        }

        case "tool": {
            if (!hasExternalTools) return null;
            const label = msg.tool_call_id
                ? `Tool Result: ${msg.tool_call_id}${msg.name ? ` (${msg.name})` : ""}`
                : `Tool Result`;
            return `[${label}]\n${text}`;
        }

        default:
            return text || null;
    }
}

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
export function messagesToPrompt(
    messages: OpenAIChatMessage[],
    hasExternalTools = false
): string {
    const nonSystemMessages = messages.filter((msg) => msg.role !== "system");
    const parts: string[] = [];
    for (const msg of nonSystemMessages) {
        const part = renderMessage(msg, hasExternalTools);
        if (part) parts.push(part);
    }

    if (parts.length === 0) return "";

    const SEPARATOR = "\n\n";
    const sepBytes = Buffer.byteLength(SEPARATOR, "utf8");
    const partBytes = parts.map((p) => Buffer.byteLength(p, "utf8"));
    let totalBytes = partBytes.reduce(
        (sum, b, i) => sum + b + (i > 0 ? sepBytes : 0),
        0,
    );

    if (totalBytes <= PROMPT_BUDGET_BYTES) {
        return parts.join(SEPARATOR).trim();
    }

    // Over budget — drop the oldest parts one at a time, but always keep
    // the most recent message (that is the actual user turn the model
    // needs to answer). Surface the truncation in the prompt itself so the
    // model knows context was clipped.
    const truncationBytes = Buffer.byteLength(TRUNCATION_NOTE, "utf8") + sepBytes;
    let dropFrom = 0;
    while (dropFrom < parts.length - 1 && totalBytes + truncationBytes > PROMPT_BUDGET_BYTES) {
        totalBytes -= partBytes[dropFrom] + sepBytes;
        dropFrom += 1;
    }

    if (dropFrom > 0) {
        console.error(
            `[messagesToPrompt] Truncated ${dropFrom} oldest message(s) ` +
                `to fit ${PROMPT_BUDGET_BYTES}-byte budget`,
        );
    }

    return [TRUNCATION_NOTE, ...parts.slice(dropFrom)].join(SEPARATOR).trim();
}

// ─── Stop-sequence bleed stripping ────────────────────────────────

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
export function stripAssistantBleed(text: string): string {
    // Patterns Claude may hallucinate as the start of the next human turn
    const BLEED_PATTERNS = ["\n[User]", "\n[Human]", "\nHuman:"];
    let cutAt = -1;
    for (const pattern of BLEED_PATTERNS) {
        const idx = text.indexOf(pattern);
        if (idx !== -1 && (cutAt === -1 || idx < cutAt)) {
            cutAt = idx;
        }
    }
    if (cutAt !== -1) {
        const stripped = text.slice(0, cutAt).trimEnd();
        console.error(
            `[stripAssistantBleed] Stripped ${text.length - cutAt} chars of bleed at offset ${cutAt}`
        );
        return stripped;
    }
    return text;
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
    // External tools: present and not explicitly disabled
    const hasExternalTools =
        Array.isArray(request.tools) &&
        request.tools.length > 0 &&
        request.tool_choice !== "none";

    return {
        prompt: messagesToPrompt(request.messages, hasExternalTools),
        systemPrompt: extractSystemPrompt(request.messages, hasExternalTools ? request.tools : undefined),
        model: extractModel(request.model),
    };
}
