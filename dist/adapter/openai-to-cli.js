/**
 * Converts OpenAI chat request format to Claude CLI input
 */
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
const XML_TOOL_PATTERN = new RegExp(
    `<(${XML_TOOL_TAGS.join("|")})[>\\s][\\s\\S]*?<\\/\\1>|<(${XML_TOOL_TAGS.join("|")})[>\\s][\\s\\S]*?(?=\\n\\n|$)`, "gi"
);
/**
 * Clean XML tool call patterns from assistant message content.
 * OpenClaw's conversation history may contain assistant messages with XML-formatted
 * tool calls (e.g. <Bash><command>...</command></Bash>). If passed to the CLI as-is,
 * the model mimics this format instead of using native tool_use blocks.
 *
 * We replace XML tool blocks with a brief summary to preserve context without the format.
 */
function cleanAssistantContent(content) {
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
    // Collapse excessive consecutive summaries
    cleaned = cleaned.replace(/(\[[\w\s:\/._-]+\]\s*){4,}/g, (match) => {
        const items = match.trim().split('\n').filter(Boolean);
        return items.slice(0, 3).join('\n') + `\n[...and ${items.length - 3} more tool calls]\n`;
    });
    return cleaned.trim();
}
/**
 * Maps model strings from OpenClaw to Claude CLI --model values.
 *
 * CLI accepts either aliases (opus/sonnet/haiku → latest version)
 * or full model names (claude-opus-4-5-20251101 → specific version).
 *
 * When value is a short alias (opus/sonnet/haiku), CLI uses the latest version.
 * When value is a full model name, CLI uses that specific version.
 */
const MODEL_MAP = {
    // Short aliases → CLI built-in aliases (always latest)
    "opus": "opus",
    "sonnet": "sonnet",
    "haiku": "haiku",

    // Opus family
    "claude-opus-4": "opus",                                // generic → latest (4.6)
    "claude-opus-4-6": "opus",                              // 4.6 = latest opus
    "claude-opus-4-5": "claude-opus-4-5-20251101",          // 4.5 = specific version
    "claude-opus-4-5-20251101": "claude-opus-4-5-20251101",
    "claude-opus-4-1": "claude-opus-4-1-20250805",
    "claude-opus-4-1-20250805": "claude-opus-4-1-20250805",
    "claude-opus-4-0": "claude-opus-4-20250514",
    "claude-opus-4-20250514": "claude-opus-4-20250514",

    // Sonnet family
    "claude-sonnet-4": "sonnet",                            // generic → latest (4.5)
    "claude-sonnet-4-5": "sonnet",                          // 4.5 = latest sonnet
    "claude-sonnet-4-5-20250929": "sonnet",
    "claude-sonnet-4-0": "claude-sonnet-4-20250514",
    "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",

    // Haiku family
    "claude-haiku-4": "haiku",                              // generic → latest (4.5)
    "claude-haiku-4-5": "haiku",                            // 4.5 = latest haiku
    "claude-haiku-4-5-20251001": "haiku",
};
/**
 * Extract Claude CLI --model value from request model string.
 * Strips provider prefixes (maxproxy/, claude-code-cli/) before lookup.
 * Falls back to "opus" for unrecognized models.
 */
export function extractModel(model) {
    if (!model) return "opus";
    // Try direct lookup
    if (MODEL_MAP[model]) {
        return MODEL_MAP[model];
    }
    // Strip provider prefixes: "maxproxy/claude-opus-4-5" → "claude-opus-4-5"
    const stripped = model.replace(/^(claude-code-cli|maxproxy)\//, "");
    if (MODEL_MAP[stripped]) {
        return MODEL_MAP[stripped];
    }
    // If it looks like a full Claude model name, pass it through directly
    // (CLI accepts full model names like "claude-opus-4-5-20251101")
    if (stripped.startsWith("claude-")) {
        return stripped;
    }
    // Default to opus (Claude Max subscription)
    return "opus";
}
/**
 * CLI tool usage instruction appended to the system prompt.
 * This ensures the CLI model uses its native tool system (Bash, Read, Write, etc.)
 * instead of outputting XML-formatted tool calls as text.
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

## OpenClaw Tools (via oc-tool)
Use \`oc-tool\` in Bash for OpenClaw platform operations. Args are always JSON.

### Browser
  oc-tool browser status                             # connection status
  oc-tool browser tabs                               # list open tabs
  oc-tool browser navigate '{"targetUrl":"URL"}'     # go to URL
  oc-tool browser snapshot                           # get page accessibility tree (returns refs like e6, e12)
  oc-tool browser snapshot '{"interactive":true}'    # interactive elements only
  oc-tool browser screenshot                         # capture page image (returns MEDIA: path)
  oc-tool browser pdf                                # render page as PDF (returns MEDIA: path)
  oc-tool browser console '{"expression":"JS_CODE"}' # execute JavaScript in page
  oc-tool browser act '{"request":{"kind":"click","ref":"e6"}}'
  oc-tool browser act '{"request":{"kind":"type","ref":"e3","text":"hello"}}'
  oc-tool browser act '{"request":{"kind":"press","key":"Enter"}}'
  oc-tool browser act '{"request":{"kind":"hover","ref":"e5"}}'
  oc-tool browser act '{"request":{"kind":"select","ref":"e4","values":["opt1"]}}'
  oc-tool browser act '{"request":{"kind":"fill","fields":[{"ref":"e2","value":"test"}]}}'
  oc-tool browser act '{"request":{"kind":"evaluate","expression":"document.title"}}'
  oc-tool browser upload '{"ref":"e3","filePath":"/path/to/file"}'  # upload file to input
  oc-tool browser dialog '{"action":"accept"}'       # handle JS alert/confirm/prompt
Browser act rules:
- act action always needs a "request" object with "kind" field
- kind values: click, type, press, hover, drag, select, fill, resize, wait, evaluate
- "ref" comes from snapshot output — always run snapshot first to get refs

### Cron (Scheduled Tasks)
  oc-tool cron status                                # cron system status
  oc-tool cron list                                  # list all jobs
  oc-tool cron add '{"name":"job-name","schedule":{"kind":"cron","expression":"0 8 * * *","tz":"Asia/Taipei"},"payload":{"kind":"agentTurn","message":"your prompt"},"deliver":"announce","channel":"telegram"}'
  oc-tool cron add '{"name":"once","schedule":{"kind":"at","at":"2026-02-17T09:00:00+08:00"},"payload":{"kind":"agentTurn","message":"..."},"deliver":"announce"}'
  oc-tool cron add '{"name":"every-30m","schedule":{"kind":"every","intervalMs":1800000},"payload":{"kind":"agentTurn","message":"..."}}'
  oc-tool cron update '{"name":"job-name","schedule":{...}}'  # patch existing job
  oc-tool cron remove '{"name":"job-name"}'
  oc-tool cron run '{"name":"job-name"}'             # trigger immediately
  oc-tool cron runs '{"name":"job-name"}'            # list past run history
Schedule kinds: "cron" (5-field + timezone), "at" (one-shot ISO timestamp), "every" (intervalMs)
Payload kinds: "agentTurn" (isolated run with message), "systemEvent" (heartbeat event)
Deliver: "announce" (send result to chat), "none" (internal only)

### Message (Send to Channels)
  oc-tool message send '{"channel":"telegram","target":"telegram:<USER_ID>","message":"..."}'
  oc-tool message send '{"channel":"telegram","target":"telegram:<USER_ID>","message":"...","replyToId":"<MSG_ID>"}'
  oc-tool message read '{"channel":"telegram","target":"telegram:<CHAT_ID>","limit":10}'
  oc-tool message edit '{"channel":"telegram","target":"telegram:<CHAT_ID>","messageId":"<ID>","message":"new text"}'
  oc-tool message react '{"channel":"telegram","target":"telegram:<CHAT_ID>","messageId":"<ID>","emoji":"👍"}'
  oc-tool message pin '{"channel":"telegram","target":"telegram:<CHAT_ID>","messageId":"<ID>"}'

### Sessions
  oc-tool sessions_list                              # list active sessions
  oc-tool sessions_history '{"sessionKey":"...","limit":N}'  # get conversation history
  oc-tool session_status '{"sessionKey":"..."}'      # check session state

### TTS (Text-to-Speech)
  oc-tool tts speak '{"text":"..."}'                 # generate voice audio (returns MEDIA: path)

### Web
  oc-tool web_search '{"query":"..."}'               # search the web
  oc-tool web_fetch '{"url":"..."}'                  # fetch web page content

### Image Analysis
  oc-tool image '{"url":"file:///path/to/image.png","prompt":"describe this image"}'

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
/**
 * Extract system prompt from messages (returned separately for --system-prompt flag)
 */
export function extractSystemPrompt(messages) {
    const systemParts = [];
    for (const msg of messages) {
        if (msg.role === "system") {
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            systemParts.push(content);
        }
    }
    const base = systemParts.join("\n\n") || "";
    // Always append CLI tool instruction to prevent XML tool mimicking
    return (base + CLI_TOOL_INSTRUCTION).trim() || null;
}
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * System messages are extracted separately (passed via --system-prompt flag).
 * XML tool patterns in assistant messages are cleaned by cleanAssistantContent()
 * to prevent the model from mimicking XML format instead of using native tools.
 */
export function messagesToPrompt(messages) {
    // Filter out system messages (handled separately via --system-prompt)
    const nonSystemMessages = messages.filter((msg) => msg.role !== "system");
    const parts = [];
    for (const msg of nonSystemMessages) {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        switch (msg.role) {
            case "user":
                parts.push(`[User]\n${content}`);
                break;
            case "assistant": {
                // Skip assistant messages that are purely tool_calls with no text content
                // (OpenAI format: tool invocations are in msg.tool_calls, not content)
                if (msg.tool_calls && (!content || content === "null")) {
                    break;
                }
                // Clean XML tool patterns from assistant messages to prevent
                // the CLI model from mimicking OpenClaw's XML tool format
                const cleaned = cleanAssistantContent(content);
                if (cleaned) {
                    parts.push(`[Assistant]\n${cleaned}`);
                }
                break;
            }
            case "tool":
                // Skip tool results entirely — the CLI has its own tool system.
                // Including these just adds noise and confusion.
                break;
            default:
                parts.push(content);
                break;
        }
    }
    return parts.join("\n\n").trim();
}
/**
 * Extract only the latest user message for resumed sessions.
 * When resuming, CLI already has the full conversation history in its session file.
 * Sending the full history would duplicate context and waste tokens.
 */
export function extractLatestUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            const content = messages[i].content;
            return typeof content === "string" ? content : JSON.stringify(content);
        }
    }
    // Fallback: use full prompt if no user message found
    return messagesToPrompt(messages);
}
/**
 * Convert OpenAI chat request to CLI input format
 *
 * @param request - OpenAI chat request
 * @param hasExistingSession - If true, only extract the latest user message
 *                             (CLI will resume from saved session with full history)
 */
export function openaiToCli(request, hasExistingSession = false) {
    const prompt = hasExistingSession
        ? extractLatestUserMessage(request.messages)
        : messagesToPrompt(request.messages);
    return {
        prompt,
        // Don't re-send system prompt on resume — CLI already has it from the session
        systemPrompt: hasExistingSession ? null : extractSystemPrompt(request.messages),
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
        isResuming: hasExistingSession,
    };
}
