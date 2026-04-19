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
    startedAt: number;       // Date.now() when the request was received
    completedAt: number | null;
}

/** Serialized form returned by the API (adds computed elapsedMs). */
export interface RequestEntryJSON {
    id: string;
    inputLength: number;
    status: RequestStatus;
    outputLength: number;
    startedAt: string;       // ISO 8601
    elapsedMs: number;
}

const MAX_ENTRIES = 200;

// Ordered oldest → newest.
const entries: RequestEntry[] = [];

/**
 * Register a new in-flight request.
 */
export function trackRequest(id: string, inputLength: number): void {
    if (entries.length >= MAX_ENTRIES) {
        entries.shift();
    }
    entries.push({
        id,
        inputLength,
        status: "in progress",
        outputLength: 0,
        startedAt: Date.now(),
        completedAt: null,
    });
}

/**
 * Update an existing tracked request (e.g. on completion or error).
 * Silently no-ops if the id is not found (already evicted).
 */
export function updateRequest(
    id: string,
    patch: Partial<Pick<RequestEntry, "status" | "outputLength">>,
): void {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    if (patch.status !== undefined) {
        entry.status = patch.status;
        if (patch.status === "completed" || patch.status === "error") {
            entry.completedAt = Date.now();
        }
    }
    if (patch.outputLength !== undefined) {
        entry.outputLength = patch.outputLength;
    }
}

/**
 * Increment the output length for an in-flight request.
 */
export function addOutputBytes(id: string, bytes: number): void {
    const entry = entries.find((e) => e.id === id);
    if (entry) entry.outputLength += bytes;
}

/**
 * Return the most recent `n` entries (newest first).
 * Pass -1 or omit to return all.
 */
export function getRequests(n?: number): RequestEntryJSON[] {
    const now = Date.now();
    // Copy and reverse so newest is first.
    const reversed = [...entries].reverse();
    const slice = n != null && n > 0 ? reversed.slice(0, n) : reversed;
    return slice.map((e) => ({
        id: e.id,
        inputLength: e.inputLength,
        status: e.status,
        outputLength: e.outputLength,
        startedAt: new Date(e.startedAt).toISOString(),
        elapsedMs: (e.completedAt ?? now) - e.startedAt,
    }));
}

/**
 * Return the number of currently in-progress requests.
 */
export function getActiveCount(): number {
    return entries.filter((e) => e.status === "in progress").length;
}
