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
 * Memory: the internal buffer is bounded to MAX_SENTINEL_LEN bytes — flushed
 * content is discarded, so memory usage is O(chunk_size) not O(response_size).
 *
 * Usage:
 *   const detector = new BleedDetector();
 *   const toWrite = detector.push(incomingText); // returns safe text to emit
 *   const tail    = detector.flush();             // call once at stream end
 */
export class BleedDetector {
    /** Look-ahead buffer — bounded to MAX_SENTINEL_LEN chars after each flush. */
    tail = "";
    _bleedDetected = false;
    get bleedDetected() {
        return this._bleedDetected;
    }
    /**
     * Append incoming text and return the safe portion ready to be written.
     * Holds back the last MAX_SENTINEL_LEN chars as a look-ahead buffer so
     * sentinels split across two chunks are still caught.
     */
    push(incoming) {
        if (this._bleedDetected)
            return "";
        this.tail += incoming;
        const safe = stripAssistantBleed(this.tail);
        if (safe.length < this.tail.length) {
            this._bleedDetected = true;
            console.error("[Stream] Bleed detected — halting delta stream");
            return safe;
        }
        const flushUpTo = Math.max(0, this.tail.length - MAX_SENTINEL_LEN);
        if (flushUpTo === 0)
            return "";
        const out = this.tail.slice(0, flushUpTo);
        this.tail = this.tail.slice(flushUpTo);
        return out;
    }
    /**
     * Flush the remaining buffered tail. Call exactly once when the stream ends.
     */
    flush() {
        if (this._bleedDetected)
            return "";
        return stripAssistantBleed(this.tail);
    }
}
//# sourceMappingURL=bleed-detector.js.map