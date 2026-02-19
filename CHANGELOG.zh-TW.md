# 更新日誌

## [1.3.0] - 2026-02-19

### TypeScript 原始碼
- **新增 `src/` 目錄，包含完整 TypeScript 原始碼** — 專案現在附帶可閱讀的原始碼，不再只有編譯後的 `dist/` 輸出。
- 新增 `tsconfig.json`，可從原始碼編譯（`npm run build`）。

### NO_REPLY 修復（OpenClaw 整合）
- **`sanitizeSystemPrompt()`** — 在傳遞給 Claude CLI 之前，移除 OpenClaw 的 `NO_REPLY`、`HEARTBEAT_OK` 和 `Tooling` 區段。此前 Claude CLI 會遵循「以 NO_REPLY 回應」的指令，導致 gateway 將所有回應視為靜默回覆而抑制。
- **NO_REPLY 歷史過濾** — 建構對話歷史時，跳過僅包含 `"NO_REPLY"` 的 assistant 訊息，防止模型延續 NO_REPLY 模式。

### 內容格式處理
- **`extractText()`** — 處理 OpenClaw gateway 的 string 和 array 兩種內容格式。此前當內容以 `[{type:"text", text:"..."}]` 傳送時，會導致 `500 msg.content.trim is not a function` 錯誤。

### 串流變更
- **以直接 delta 串流取代 SmartStream** — 每個 `content_delta` 事件現在立即寫入 SSE 回應串流。先前的 SmartStream 緩衝區（會保留 delta 直到最後一輪）已移除。

### 程式碼清理
- 移除未使用的函數：`cliToOpenaiChunk`、`extractTextContent`。
- 移除未使用的型別：`ClaudeCliHookStarted`、`ClaudeCliHookResponse`、`ClaudeCliSystemMessage`、`OpenAIModel`、`OpenAIModelList`、`OpenAIError`。
- 移除未使用的 type guard：`isStreamEvent()`、`isSystemInit()`。
- 移除未使用的 SessionManager 方法：`getAll()`、`size`。
- 重新命名舊版 `clawdbotId` 為 `conversationId`。

## [1.2.0] - 2026-02-16

### 進度通知
- **Telegram 即時進度更新** — CLI 執行工具呼叫（Bash、WebSearch、檔案 I/O 等）時，發送進度訊息到 Telegram，顯示正在執行的工具（如 `⏳ 搜尋網頁... 執行命令...`）。
- 最終回應到達時自動刪除進度訊息。
- 最小更新間隔 3 秒，避免 Telegram API 速率限制。
- Bot token 從 `~/.openclaw/openclaw.json` 讀取（無需額外設定）。

### 程式碼清理
- 移除未使用函數：`cliToOpenaiChunk`、`extractTextContent`、`trimToRecentContext`、`MAX_CONTEXT_PAIRS`。
- 移除所有內部 "Clawdbot" 品牌名稱 — 重新命名為通用名稱。
- 移除所有 `.js.map` / `.d.ts.map` source map 檔案及參考。
- 從 `package.json` 移除 `clawdbot` peerDependency。

## [1.1.0] - 2026-02-16

### Smart Streaming（智慧串流）
- **僅將最後一輪的文字串流給客戶端。** 中間的工具呼叫輪次（如「讓我看看...」）會被緩衝並在新輪次開始（`message_start`）時丟棄。客戶端只會收到最後的 assistant 回覆。
- 透過 CLI `stream_event` / `message_start` 事件偵測輪次邊界。
- 被丟棄的輪次內容記錄到 stderr 供除錯使用。

### 超時與限制調整
- **移除 `--max-turns 15`** — CLI 現在可以執行任意多次工具呼叫來完成複雜任務。
- **移除絕對超時（600 秒硬限制）** — 不再對總執行時間設上限。
- **活動超時從 3 分鐘提高到 10 分鐘** — 只有當子程序連續 10 分鐘無 stdout 輸出時才會被終止（表示卡住了）。
- **超時 Telegram 通知** — 活動超時觸發時，透過 `oc-tool message send` 發送 `⚠️ 任務超時被終止` 訊息到 Telegram，讓使用者知道發生了什麼。

### 語音訊息支援
- 在 system prompt 中加入 `[[audio_as_voice]]` 標籤指令，使 TTS 回覆以 Telegram 語音氣泡（`sendVoice`）而非檔案附件（`sendAudio`）傳送。

### System Prompt 改善
- 加入正確的 `browser act` 格式範例，使用 `request.kind` 結構。
- 加入 `MEDIA:` 格式規則（必須獨佔一行）。
- 加入回應格式規則（不含內部思考、使用與使用者相同的語言）。
- 加入長時間執行命令的 keepalive 模式指引。
- 更新超時文件以反映 10 分鐘活動超時。

### Bug 修復
- 修復 `browser act` 因缺少 `request` 包裝物件導致的 500 錯誤。
- 修復 TTS 產生空白/錯誤音訊的問題，為中文配置 `zh-TW-HsiaoChenNeural` 語音（Edge TTS 預設語音僅支援英文）。
- 修復 `MEDIA:` 路徑緊貼前方文字時無法被解析的問題。

## [1.0.0] - 2026-02-15

- 初始版本：以 OpenAI 相容 API 伺服器包裝 Claude Code CLI。
- 對話管理，支援 session resume。
- 對話歷史中的 XML 工具模式清理。
- 模型對應（opus/sonnet/haiku 系列）。
- 串流（SSE）與非串流回應模式。
