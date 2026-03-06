/**
 * Canonical model registry for the Claude Code CLI proxy.
 *
 * Single source of truth consumed by:
 *   - src/index.ts          → plugin provider config
 *   - src/server/routes.ts  → GET /v1/models response
 *   - src/adapter/openai-to-cli.ts → model name → CLI alias mapping
 */
export interface ModelInfo {
    id: string;
    name: string;
    /** CLI alias passed to claude --model */
    alias: "opus" | "sonnet" | "haiku";
    reasoning: boolean;
}
export declare const AVAILABLE_MODELS: readonly ModelInfo[];
/**
 * Maps model strings from OpenClaw to Claude CLI --model values.
 *
 * CLI accepts either aliases (opus/sonnet/haiku → latest version)
 * or full model names (claude-opus-4-5-20251101 → specific version).
 */
export declare const MODEL_MAP: Record<string, string>;
//# sourceMappingURL=models.d.ts.map