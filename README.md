# Claude Max API Proxy

**Turn your $200/month Claude Max subscription into a full OpenAI-compatible API — with agentic tool-calling, smart streaming, and Telegram bot integration.**

Most people pay $200/month for Claude Max but can only use it through the web UI or Claude Code CLI. This proxy unlocks your subscription as a standard API, so any OpenAI-compatible client (chatbots, automation platforms, custom apps) can use it — at zero extra cost.

## The Problem

| Approach | Monthly Cost | What You Get |
|----------|-------------|--------------|
| Claude API (pay-per-use) | ~$50–200+ depending on usage | Full API access, but expensive |
| Claude Max subscription | $200 flat | Web UI + Claude Code CLI only |
| **This Proxy** | **$0 extra** (uses your Max sub) | **Full API access via CLI** |

Anthropic blocks OAuth tokens from third-party API use. But Claude Code CLI *can* use your subscription. This proxy wraps the CLI as a subprocess and exposes a standard OpenAI-compatible HTTP API.

## Key Features

### Smart Streaming
Standard proxies dump all intermediate output to the client — tool-calling thoughts, internal reasoning, debugging text. **Smart Streaming buffers each turn and only streams the final response.** Your users see a clean answer, not the sausage-making.

```
Without Smart Streaming:
  "Let me check that for you..."    ← leaked to client
  [tool call: Bash echo hello]      ← leaked to client
  "The result is: hello"            ← actual answer

With Smart Streaming:
  "The result is: hello"            ← only this reaches the client
```

### Agentic Tool Calling (No Turn Limits)
The CLI model has full access to tools — Bash, file I/O, web search, browser automation. Unlike basic proxies that cap tool calls at a fixed number, this proxy removes turn limits entirely. Complex multi-step tasks (code generation, data analysis, file processing) run to completion.

### Session Persistence
Conversations maintain context across messages. The proxy maps each client conversation to a Claude CLI session, so the model remembers what you discussed — no need to resend the full history every time.

### Timeout Protection with Notifications
A 10-minute activity timeout catches genuinely stuck processes, while letting long-running tasks (downloads, builds) complete normally. When a timeout fires, you get notified via Telegram (or your configured channel) instead of silently failing.

### OpenClaw / Telegram Integration
Built to work with [OpenClaw](https://openclaw.dev) as a Telegram bot backend:
- **Voice messages** — Receives voice notes, transcribes via Whisper, replies with TTS voice bubbles
- **Browser automation** — Controls a managed Chrome instance for web tasks
- **Cron jobs** — Scheduled task execution
- **Media attachments** — Screenshots, files, audio sent as native Telegram media

## How It Works

```
Your App / Telegram Bot / Any OpenAI Client
         ↓
    POST /v1/chat/completions (OpenAI format)
         ↓
    Claude Max API Proxy (this project)
         ↓  converts request → CLI input
         ↓  manages sessions & streaming
         ↓
    Claude Code CLI (subprocess with tools)
         ↓  uses your Max subscription OAuth
         ↓
    Anthropic API
         ↓
    Response → Smart Stream filter → OpenAI SSE format → Your App
```

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

## Use With Popular Tools

### OpenClaw (Telegram Bot)

Add as a model provider in `openclaw.json`:
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

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Continue.dev (VS Code)

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Any OpenAI-Compatible Client

Point it to `http://localhost:3456/v1` with any API key. The proxy ignores the key and uses your Claude CLI authentication.

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
│   ├── routes.js            # Smart streaming, SSE, timeout notifications
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

## License

MIT

## Credits

- Original concept by [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) (fork origin)
- Smart streaming, session management, and OpenClaw integration by [@anthropic-ai/claude-code](https://github.com/anthropics/claude-code)
