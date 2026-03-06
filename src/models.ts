/**
 * Canonical model registry for the Claude Code CLI proxy.
 *
 * Single source of truth consumed by:
 *   - src/index.ts          → plugin provider config
 *   - src/server/routes.ts  → GET /v1/models response
 *   - src/adapter/openai-to-cli.ts → model name → CLI alias mapping
 */

// ─── Available models ──────────────────────────────────────────────

export interface ModelInfo {
    id: string;
    name: string;
    /** CLI alias passed to claude --model */
    alias: "opus" | "sonnet" | "haiku";
    reasoning: boolean;
}

export const AVAILABLE_MODELS: readonly ModelInfo[] = [
    { id: "claude-opus-4",     name: "Claude Opus 4",    alias: "opus",   reasoning: true  },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", alias: "sonnet", reasoning: false },
    { id: "claude-sonnet-4",   name: "Claude Sonnet 4.5", alias: "sonnet", reasoning: false },
    { id: "claude-haiku-4",    name: "Claude Haiku 4",    alias: "haiku",  reasoning: false },
] as const;

// ─── Model name → CLI alias mapping ───────────────────────────────

/**
 * Maps model strings from OpenClaw to Claude CLI --model values.
 *
 * CLI accepts either aliases (opus/sonnet/haiku → latest version)
 * or full model names (claude-opus-4-5-20251101 → specific version).
 */
export const MODEL_MAP: Record<string, string> = {
    // Short aliases → CLI built-in aliases (always latest)
    "opus":   "opus",
    "sonnet": "sonnet",
    "haiku":  "haiku",

    // Opus family
    "claude-opus-4":            "opus",
    "claude-opus-4-6":          "opus",
    "claude-opus-4-5":          "claude-opus-4-5-20251101",
    "claude-opus-4-5-20251101": "claude-opus-4-5-20251101",
    "claude-opus-4-1":          "claude-opus-4-1-20250805",
    "claude-opus-4-1-20250805": "claude-opus-4-1-20250805",
    "claude-opus-4-0":          "claude-opus-4-20250514",
    "claude-opus-4-20250514":   "claude-opus-4-20250514",

    // Sonnet family
    "claude-sonnet-4":            "sonnet",
    "claude-sonnet-4-6":          "sonnet",
    "claude-sonnet-4-5":          "sonnet",
    "claude-sonnet-4-5-20250929": "sonnet",
    "claude-sonnet-4-0":          "claude-sonnet-4-20250514",
    "claude-sonnet-4-20250514":   "claude-sonnet-4-20250514",

    // Haiku family
    "claude-haiku-4":            "haiku",
    "claude-haiku-4-5":          "haiku",
    "claude-haiku-4-5-20251001": "haiku",
};
