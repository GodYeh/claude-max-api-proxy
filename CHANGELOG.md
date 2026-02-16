# Changelog

## [1.2.0] - 2026-02-16

### Progress Notifications
- **Real-time Telegram progress updates** — When the CLI executes tool calls
  (Bash, WebSearch, file I/O, etc.), a progress message is sent to Telegram
  showing which tools are running (e.g. `⏳ 搜尋網頁... 執行命令...`).
- Progress messages are automatically deleted when the final response arrives.
- Throttled to 3-second minimum interval to avoid Telegram API rate limits.
- Bot token read from `~/.openclaw/openclaw.json` (no extra config needed).

### Code Cleanup
- Removed unused functions: `cliToOpenaiChunk`, `extractTextContent`,
  `trimToRecentContext`, `MAX_CONTEXT_PAIRS`.
- Removed all internal "Clawdbot" branding — renamed to generic terms.
- Removed all `.js.map` / `.d.ts.map` source map files and references.
- Removed `clawdbot` peerDependency from `package.json`.

### Files Changed
- `dist/server/routes.js` — ProgressReporter class, Telegram API integration
- `dist/adapter/cli-to-openai.js` — dead code removal
- `dist/adapter/openai-to-cli.js` — dead code removal
- All `.js` / `.d.ts` files — branding cleanup

## [1.1.0] - 2026-02-16

### Smart Streaming
- **Only stream the final turn's text to the client.** Intermediate tool-calling
  turns (e.g. "Let me check...") are buffered and discarded when a new turn
  starts (`message_start`). The client only receives the last assistant reply.
- Turn boundary detection via CLI `stream_event` / `message_start` events.
- Discarded turn content is logged to stderr for debugging.

### Timeout & Limits Overhaul
- **Removed `--max-turns 15`** — the CLI can now run as many tool-call rounds
  as needed to complete complex tasks.
- **Removed absolute timeout (600s hard limit)** — no more hard cap on total
  execution time.
- **Activity timeout raised from 3 min → 10 min** — the subprocess is only
  killed if it produces no stdout for 10 consecutive minutes (indicates a hang).
- **Telegram notification on timeout** — when the activity timeout fires, a
  `⚠️ 任務超時被終止` message is sent to Telegram via `oc-tool message send`
  so the user knows what happened.

### Voice Message Support
- Added `[[audio_as_voice]]` tag instruction to the system prompt so TTS
  replies are sent as Telegram voice bubbles (`sendVoice`) instead of file
  attachments (`sendAudio`).

### System Prompt Improvements
- Added correct `browser act` format examples with `request.kind` structure.
- Added `MEDIA:` formatting rules (must be on its own line).
- Added response format rules (no internal thinking, match user language).
- Added long-running command guidance with keepalive patterns.
- Updated timeout documentation to reflect 10-minute activity timeout.

### Bug Fixes
- Fixed `browser act` 500 errors caused by missing `request` wrapper object.
- Fixed TTS producing empty/wrong audio by configuring `zh-TW-HsiaoChenNeural`
  voice for Chinese text (Edge TTS default voice only supports English).
- Fixed `MEDIA:` path not being parsed when glued to preceding text.

### Files Changed
- `dist/server/routes.js` — smart streaming, timeout notification
- `dist/subprocess/manager.js` — timeout/limits overhaul
- `dist/adapter/openai-to-cli.js` — system prompt updates

## [1.0.0] - 2026-02-15

- Initial release with OpenAI-compatible API server wrapping Claude Code CLI.
- Session management with resume support.
- XML tool pattern cleaning for conversation history.
- Model mapping (opus/sonnet/haiku families).
- Streaming (SSE) and non-streaming response modes.
