import { stripAssistantBleed } from "../adapter/openai-to-cli.js";

const BLEED_SENTINELS = ["\n[User]", "\n[Human]", "\nHuman:"];
const MAX_SENTINEL_LEN = Math.max(...BLEED_SENTINELS.map((s) => s.length));

/**
 * Streaming bleed detector.
 *
 * Buffers the tail of an in-progress stream to catch [User]/[Human]/Human:
 * bleed patterns that can appear when the model generates continuation text.
 * Safe text is returned incrementally; once bleed is detected, further
 * pushes return an empty string.
 *
 * Usage:
 *   const detector = new BleedDetector();
 *   const toWrite = detector.push(incomingText); // returns safe text to emit
 *   const tail    = detector.flush();             // call once at stream end
 */
export class BleedDetector {
    private accumulated = "";
    private totalFlushed = 0;
    private _bleedDetected = false;

    get bleedDetected(): boolean {
        return this._bleedDetected;
    }

    /**
     * Append incoming text and return the safe portion ready to be written.
     * Holds back the last MAX_SENTINEL_LEN chars as a look-ahead buffer so
     * sentinels split across two chunks are still caught.
     */
    push(incoming: string): string {
        if (this._bleedDetected) return "";

        this.accumulated += incoming;

        const safe = stripAssistantBleed(this.accumulated);
        if (safe.length < this.accumulated.length) {
            this._bleedDetected = true;
            console.error("[Stream] Bleed detected — halting delta stream");
            return safe.slice(this.totalFlushed);
        }

        const safeLen = Math.max(0, this.accumulated.length - MAX_SENTINEL_LEN);
        const toFlush = safeLen - this.totalFlushed;
        if (toFlush <= 0) return "";

        const out = this.accumulated.slice(this.totalFlushed, this.totalFlushed + toFlush);
        this.totalFlushed += toFlush;
        return out;
    }

    /**
     * Flush the remaining buffered tail. Call exactly once when the stream ends.
     */
    flush(): string {
        if (this._bleedDetected) return "";
        return stripAssistantBleed(this.accumulated).slice(this.totalFlushed);
    }
}
