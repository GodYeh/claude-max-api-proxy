/**
 * Session Manager
 *
 * Maps conversation IDs to Claude CLI session IDs
 * for maintaining conversation context across requests.
 */
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
const SESSION_FILE = path.join(process.env.HOME || "/tmp", ".claude-code-cli-sessions.json");
// Session TTL: 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
class SessionManager {
    sessions = new Map();
    loaded = false;
    /**
     * Load sessions from disk
     */
    async load() {
        if (this.loaded)
            return;
        try {
            const data = await fs.readFile(SESSION_FILE, "utf-8");
            const parsed = JSON.parse(data);
            this.sessions = new Map(Object.entries(parsed));
            this.loaded = true;
            console.log(`[SessionManager] Loaded ${this.sessions.size} sessions`);
        }
        catch {
            // File doesn't exist or is invalid, start fresh
            this.sessions = new Map();
            this.loaded = true;
        }
    }
    /**
     * Save sessions to disk
     */
    async save() {
        const data = Object.fromEntries(this.sessions);
        await fs.writeFile(SESSION_FILE, JSON.stringify(data, null, 2));
    }
    /**
     * Get or create a Claude session ID for a conversation
     */
    getOrCreate(conversationId, model = "sonnet") {
        const existing = this.sessions.get(conversationId);
        if (existing) {
            existing.lastUsedAt = Date.now();
            existing.model = model;
            return existing.claudeSessionId;
        }
        const claudeSessionId = uuidv4();
        const mapping = {
            conversationId,
            claudeSessionId,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            model,
        };
        this.sessions.set(conversationId, mapping);
        console.log(`[SessionManager] Created session: ${conversationId} -> ${claudeSessionId}`);
        // Fire and forget save
        this.save().catch((err) => console.error("[SessionManager] Save error:", err));
        return claudeSessionId;
    }
    /**
     * Get existing session if it exists
     */
    get(conversationId) {
        return this.sessions.get(conversationId);
    }
    /**
     * Delete a session
     */
    delete(conversationId) {
        const deleted = this.sessions.delete(conversationId);
        if (deleted) {
            this.save().catch((err) => console.error("[SessionManager] Save error:", err));
        }
        return deleted;
    }
    /**
     * Clean up expired sessions
     */
    cleanup() {
        const cutoff = Date.now() - SESSION_TTL_MS;
        let removed = 0;
        for (const [key, session] of this.sessions) {
            if (session.lastUsedAt < cutoff) {
                this.sessions.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[SessionManager] Cleaned up ${removed} expired sessions`);
            this.save().catch((err) => console.error("[SessionManager] Save error:", err));
        }
        return removed;
    }
}
// Singleton instance
export const sessionManager = new SessionManager();
// Initialize on module load
sessionManager
    .load()
    .catch((err) => console.error("[SessionManager] Load error:", err));
// Periodic cleanup every hour
setInterval(() => {
    sessionManager.cleanup();
}, 60 * 60 * 1000);
//# sourceMappingURL=manager.js.map