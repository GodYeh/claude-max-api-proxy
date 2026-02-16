# Claude Max API Proxy

**English | [繁體中文](README.zh-TW.md)**

**Use Opus 4.6 as your daily AI assistant — through Telegram and Discord — powered by your $200/month Claude Max subscription and [OpenClaw](https://openclaw.dev).**

## Why This Exists

Opus 4.6 is the best conversational AI model available today. It has personality, strong reasoning, and a directness that no other model matches. The problem? Using it through the Anthropic API burns $10+/hour on heavy workloads. Claude Max gives you unlimited Opus for $200/month flat — but only through the web UI and Claude Code CLI.

This proxy bridges the gap. It wraps Claude Code CLI as a local HTTP server that speaks the OpenAI API format, designed to work with [OpenClaw](https://openclaw.dev) as the Telegram/Discord bot frontend.

## Why Not Just Use Session Tokens?

Many people extract Claude Max session tokens and plug them into third-party services. This works, but it's risky:

| Approach | How It Works | Risk |
|----------|-------------|------|
| **Session token extraction** | Steal cookie/token from browser | Anthropic can detect non-CLI traffic patterns (user-agent, request timing, token consumption). Account ban = all conversation history, Projects, and fine-tuned context gone forever. |
| **This proxy (Claude Code CLI)** | Every request goes through Anthropic's own binary | Indistinguishable from sitting at your terminal typing. It *is* Claude Code — just with input coming from your phone instead of your keyboard. |

The key insight: Claude Code CLI is an official Anthropic product. Traffic from it is legitimate developer usage. This proxy doesn't fake anything — it literally spawns the real CLI as a subprocess.

> Based on [Benson Sun's architecture](https://x.com/BensonTWN/status/2022718855177736395) — open-sourced for the community.

## Key Features

### One Brain, One Context
Traditional setups use one model for chat and a separate coding agent for development tasks. Two brains passing context back and forth means latency and information loss. This proxy runs everything through a single Claude Code CLI session — chatting, reading files, writing code, running tests, git commits — all in the same context. Read a requirement, edit the file, run the test, report back. No handoffs.

### Smart Streaming
Other proxies dump all intermediate output to the client — tool-calling thoughts, internal reasoning, debugging text. Smart Streaming buffers each turn and only streams the final response. Your users see a clean answer, not the sausage-making.

```
Without Smart Streaming:
  "Let me check that for you..."    ← leaked to client
  [tool call: Bash echo hello]      ← leaked to client
  "The result is: hello"            ← actual answer

With Smart Streaming:
  "The result is: hello"            ← only this reaches the client
```

### Agentic Tool Calling (No Turn Limits)
The CLI has full access to tools — Bash, file I/O, web search, browser automation. Unlike basic proxies that cap tool calls at a fixed number, this proxy removes turn limits entirely. Complex multi-step tasks run to completion.

### Full OpenClaw Agent Parity
When paired with [OpenClaw](https://openclaw.dev), this proxy achieves 100% feature parity with native OpenClaw agents:
- **Web search** — Search and summarize web content
- **Browser automation** — Playwright-powered Chrome control with login state
- **Voice messages** — Whisper transcription in, TTS voice bubbles out
- **Scheduled tasks** — Cron-based task execution
- **Sub-agents** — Spawn child agents for parallel work
- **Media attachments** — Screenshots, files, audio as native Telegram/Discord media

### Session Persistence
Conversations maintain context across messages. The proxy maps each client conversation to a Claude CLI session — no need to resend full history every time.

### Timeout Protection
10-minute activity timeout catches stuck processes while letting long-running tasks complete normally. Timeout notifications are sent to Telegram so you know what happened.

## How It Works

<p align="center">
  <img src="docs/architecture.png" alt="Architecture Diagram" width="700" />
</p>

No third-party servers. Everything runs locally on your machine. The request leaves through Anthropic's own binary — identical to you typing in your terminal.

## Quick Start

### Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai/settings/billing)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

### Install & Run

```bash
npm install -g claude-max-api-proxy
claude-max-api   # starts on http://localhost:3456
```

### Test

```bash
# Health check
curl http://localhost:3456/health

# Chat (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Auto-Start on macOS

Create `~/Library/LaunchAgents/com.claude-max-api.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.claude-max-api</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/opt/homebrew/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>/Users/YOUR_USERNAME</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <!-- Optional: for timeout notifications -->
      <key>TELEGRAM_NOTIFY_ID</key>
      <string>YOUR_TELEGRAM_USER_ID</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/claude-max-api.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-max-api.err.log</string>
  </dict>
</plist>
```

Then load it:
```bash
launchctl load ~/Library/LaunchAgents/com.claude-max-api.plist
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_NOTIFY_ID` | No | Telegram user ID for timeout notifications |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | Explicit OAuth token (otherwise uses CLI's keychain) |

### Available Models

| Model ID | Description |
|----------|-------------|
| `claude-opus-4` | Claude Opus 4 (most capable) |
| `claude-sonnet-4` | Claude Sonnet 4 (balanced) |
| `claude-haiku-4` | Claude Haiku 4 (fastest) |

Full model family support with version pinning (e.g. `claude-opus-4-5-20251101`).

## OpenClaw Integration

Add as a model provider in your `openclaw.json`:
```json
{
  "models": {
    "providers": {
      "maxproxy": {
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "not-needed",
        "api": "openai-completions"
      }
    }
  }
}
```

See the [OpenClaw documentation](https://openclaw.dev) for full setup instructions.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Architecture

```
dist/
├── adapter/
│   ├── openai-to-cli.js   # OpenAI request → CLI prompt + system prompt
│   └── cli-to-openai.js   # CLI result → OpenAI response format
├── subprocess/
│   └── manager.js          # CLI subprocess lifecycle & activity timeout
├── session/
│   └── manager.js          # Conversation → CLI session mapping
├── server/
│   ├── routes.js            # Smart streaming, SSE, progress notifications
│   ├── index.js             # Express server setup
│   └── standalone.js        # Entry point
└── types/
    └── claude-cli.js        # CLI stream-json event type guards
```

## Security

- **No shell injection** — Uses Node.js `spawn()`, not `exec()`
- **No stored credentials** — Authentication handled by Claude CLI's OS keychain
- **No hardcoded secrets** — All sensitive config via environment variables
- **Local only by default** — Binds to `127.0.0.1`, not exposed to network

## Tips

- **Don't run heartbeat/cron jobs through Opus** — Fixed-interval requests look like bot traffic. Use lightweight models (Gemini Flash, Haiku) for scheduled tasks.
- **Stay within your weekly token limits** — The proxy doesn't circumvent any usage caps. If you rarely hit your Claude Code weekly limit, you have plenty of headroom.

## License

MIT

## Credits

- Original concept and architecture by [Benson Sun](https://x.com/BensonTWN/status/2022718855177736395) — this project is an open-source implementation of his design, with some modifications
- Initial codebase forked from [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- Smart streaming, session management, and OpenClaw integration built with [Claude Code](https://github.com/anthropics/claude-code)
