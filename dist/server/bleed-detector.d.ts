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
export declare class BleedDetector {
    /** Look-ahead buffer — bounded to MAX_SENTINEL_LEN chars after each flush. */
    private tail;
    private _bleedDetected;
    get bleedDetected(): boolean;
    /**
     * Append incoming text and return the safe portion ready to be written.
     * Holds back the last MAX_SENTINEL_LEN chars as a look-ahead buffer so
     * sentinels split across two chunks are still caught.
     */
    push(incoming: string): string;
    /**
     * Flush the remaining buffered tail. Call exactly once when the stream ends.
     */
    flush(): string;
}
//# sourceMappingURL=bleed-detector.d.ts.map