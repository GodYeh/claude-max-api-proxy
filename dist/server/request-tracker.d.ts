/**
 * In-memory request tracker for the monitor endpoint.
 *
 * Keeps a circular buffer of recent request entries so the `mon` CLI
 * command can poll `/v1/requests` and display live status.
 */
export type RequestStatus = "in progress" | "completed" | "error";
export interface RequestEntry {
    id: string;
    inputLength: number;
    status: RequestStatus;
    outputLength: number;
    startedAt: number;
    completedAt: number | null;
}
/** Serialized form returned by the API (adds computed elapsedMs). */
export interface RequestEntryJSON {
    id: string;
    inputLength: number;
    status: RequestStatus;
    outputLength: number;
    startedAt: string;
    elapsedMs: number;
}
/**
 * Register a new in-flight request.
 */
export declare function trackRequest(id: string, inputLength: number): void;
/**
 * Update an existing tracked request (e.g. on completion or error).
 * Silently no-ops if the id is not found (already evicted).
 */
export declare function updateRequest(id: string, patch: Partial<Pick<RequestEntry, "status" | "outputLength">>): void;
/**
 * Increment the output length for an in-flight request.
 */
export declare function addOutputBytes(id: string, bytes: number): void;
/**
 * Return the most recent `n` entries (newest first).
 * Pass -1 or omit to return all.
 */
export declare function getRequests(n?: number): RequestEntryJSON[];
/**
 * Return the number of currently in-progress requests.
 */
export declare function getActiveCount(): number;
//# sourceMappingURL=request-tracker.d.ts.map