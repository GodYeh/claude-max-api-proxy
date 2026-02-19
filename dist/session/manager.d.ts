export interface SessionMapping {
    conversationId: string;
    claudeSessionId: string;
    createdAt: number;
    lastUsedAt: number;
    model: string;
}
declare class SessionManager {
    private sessions;
    private loaded;
    /**
     * Load sessions from disk
     */
    load(): Promise<void>;
    /**
     * Save sessions to disk
     */
    save(): Promise<void>;
    /**
     * Get or create a Claude session ID for a conversation
     */
    getOrCreate(conversationId: string, model?: string): string;
    /**
     * Get existing session if it exists
     */
    get(conversationId: string): SessionMapping | undefined;
    /**
     * Delete a session
     */
    delete(conversationId: string): boolean;
    /**
     * Clean up expired sessions
     */
    cleanup(): number;
}
export declare const sessionManager: SessionManager;
export {};
//# sourceMappingURL=manager.d.ts.map