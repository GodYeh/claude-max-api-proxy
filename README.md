# Claude Max API Proxy

**English | [繁體中文](README.zh-TW.md)**

**Use your Claude Max subscription with any OpenAI-compatible client.**

## Why This Exists

Claude Max ($200/month) offers unlimited access to Claude, but Anthropic restricts it to the web UI and Claude Code CLI — you can't use your subscription to power third-party tools.

This proxy works around that limitation. It spawns the real Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API locally. Any client that speaks the OpenAI chat completions protocol can use your Max subscription as the backend — including [OpenClaw](https://openclaw.dev) for Telegram/Discord bots.

## How It Works

```
┌─────────────┐     HTTP      ┌──────────────────┐    spawn()    ┌───────────────┐
│  Any OpenAI  │ ──────────▶ │  Claude Max API   │ ──────────▶ │  Claude Code   │
│  compatible  │ ◀────────── │  Proxy (Express)  │ ◀────────── │  CLI (--print) │
│  client      │   SSE/JSON   │  localhost:3456   │  stream-json │               │
└─────────────┘               └──────────────────┘              └───────────────┘
```

No third-party servers. Everything runs locally. Requests go through Anthropic's own CLI binary — identical to you typing in your terminal.

## Key Features

- **OpenAI-compatible API** — Drop-in replacement for any client that supports `POST /v1/chat/completions`
- **Streaming & non-streaming** — Full SSE streaming support with direct delta forwarding
- **Stateless per-request** — Each call spawns a fresh CLI subprocess; conversation history is supplied by the client on every turn (the proxy itself does not retain session state). The session manager that used to live in `src/session/` was removed in v1.3.x.
- **No turn limits** — The CLI runs as many tool-call rounds as needed for complex tasks
- **Activity timeout** — Configurable inactivity watchdog (`CLAUDE_PROXY_ACTIVITY_TIMEOUT_MS`, default 10 minutes) catches stuck processes while letting long tasks complete; both stdout and stderr count as activity
- **Concurrency cap** — `CLAUDE_PROXY_MAX_CONCURRENT` (default 4) bounds in-flight requests so a burst cannot fork unbounded CLI subprocesses
- **Prompt budget** — `CLAUDE_PROXY_PROMPT_BUDGET_BYTES` (default 100 KiB) drops the oldest history when long conversations exceed the budget
- **No native dependencies** — Pure JS, uses `child_process.spawn()` with piped stdio and `--output-format stream-json`. Prompt and system instructions are piped via stdin to avoid Linux ARG_MAX (E2BIG) on long histories.

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

## Building from Source

The project ships with full TypeScript source in `src/`.

```bash
git clone https://github.com/GodYeh/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build    # compiles src/ → dist/
npm run start    # starts the server
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEBUG` | No | Set to any value to enable request logging |
| `CLAUDE_PROXY_MAX_CONCURRENT` | No | Max concurrent chat-completions requests (default 4). Excess requests get a 429 with Retry-After. |
| `CLAUDE_PROXY_ACTIVITY_TIMEOUT_MS` | No | Inactivity watchdog timeout in ms (default 600000 = 10 min). Resets on stdout *or* stderr from the CLI. |
| `CLAUDE_PROXY_PROMPT_BUDGET_BYTES` | No | Soft cap on rendered prompt size in UTF-8 bytes (default 100000). Oldest messages are dropped when exceeded. |
| `OPENCLAW_GATEWAY_TOKEN` | No | OpenClaw gateway auth token. Falls back to `~/.openclaw/openclaw.json` if unset. |
| `OPENCLAW_GATEWAY_URL` | No | OpenClaw gateway base URL (default `http://localhost:18789`). |

### Available Models

| Model ID | Description |
|----------|-------------|
| `claude-opus-4` | Claude Opus (most capable) |
| `claude-sonnet-4` | Claude Sonnet (balanced) |
| `claude-haiku-4` | Claude Haiku (fastest) |

Full model family support with version pinning (e.g. `claude-opus-4-5-20251101`, `claude-sonnet-4-20250514`).

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

When used with [OpenClaw](https://openclaw.dev), this proxy supports all native agent features: web search, browser automation, voice messages, scheduled tasks, media attachments, and more.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Project Structure

```
src/
├── adapter/
│   ├── openai-to-cli.ts    # OpenAI request → CLI prompt + inlined system instructions
│   └── cli-to-openai.ts    # CLI JSON stream → OpenAI response format (incl. <tool_call> parsing)
├── subprocess/
│   └── manager.ts          # CLI subprocess lifecycle, activity watchdog, env scrubbing
├── server/
│   ├── routes.ts           # /v1/chat/completions: SSE streaming, bleed/auth-probe/concurrency
│   ├── index.ts            # Express server setup, CORS, error middleware
│   └── standalone.ts       # `claude-max-api` CLI entry point
├── types/
│   ├── openai.ts           # OpenAI API type definitions
│   └── claude-cli.ts       # CLI stream-json event types
└── index.ts                # OpenClaw plugin registration
```

There is no `src/session/` any more — see the **Stateless per-request** note in *Key Features*.

## Security

- **No shell injection** — Uses Node.js `spawn()`, not `exec()`
- **No stored credentials** — Authentication handled by Claude CLI's OS keychain
- **No hardcoded secrets** — All sensitive config via environment variables or external config files
- **Local only by default** — Binds to `127.0.0.1`, not exposed to network

## Tips

- **Don't run heartbeat/cron jobs through Opus** — Fixed-interval requests look like bot traffic. Use lightweight models for scheduled tasks.
- **Stay within your weekly token limits** — The proxy doesn't circumvent any usage caps. If you rarely hit your Claude Code weekly limit, you have plenty of headroom.

## License

MIT

## Credits

- Initial codebase based on [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- Session management, streaming, and OpenClaw integration built with [Claude Code](https://github.com/anthropics/claude-code)
