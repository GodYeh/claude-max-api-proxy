/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */
import { Server } from "http";
export interface ServerConfig {
    port: number;
    host?: string;
}
/**
 * Start the HTTP server
 */
export declare function startServer(config: ServerConfig): Promise<Server>;
/**
 * Stop the HTTP server
 */
export declare function stopServer(): Promise<void>;
/**
 * Get the current server instance
 */
export declare function getServer(): Server | null;
