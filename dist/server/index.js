/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */
import express from "express";
import { createServer } from "http";
import { handleChatCompletions, handleModels, handleHealth, handleRequests } from "./routes.js";
let serverInstance = null;
/**
 * Create and configure the Express app
 */
function createApp() {
    const app = express();
    // Middleware
    app.use(express.json({ limit: "10mb" }));
    // Request logging (debug mode)
    app.use((req, _res, next) => {
        if (process.env.DEBUG) {
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
        }
        next();
    });
    // CORS headers. The proxy listens on 127.0.0.1 by default, so the only
    // legitimate browser callers are pages served from localhost. We mirror
    // an Origin header back if it looks local; cross-origin requests get no
    // ACAO header at all (browser will block them). Set CLAUDE_PROXY_ALLOW_CORS_ANY=1
    // for the legacy "*" behavior if a deployment depends on it.
    const allowAnyOrigin = process.env.CLAUDE_PROXY_ALLOW_CORS_ANY === "1";
    const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (allowAnyOrigin) {
            res.setHeader("Access-Control-Allow-Origin", "*");
        }
        else if (typeof origin === "string" && LOCAL_ORIGIN_RE.test(origin)) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        next();
    });
    // Handle OPTIONS preflight
    app.options("*", (_req, res) => {
        res.sendStatus(200);
    });
    // Routes
    app.get("/health", handleHealth);
    app.get("/v1/models", handleModels);
    app.get("/v1/requests", handleRequests);
    app.post("/v1/chat/completions", handleChatCompletions);
    // 404 handler
    app.use((_req, res) => {
        res.status(404).json({
            error: {
                message: "Not found",
                type: "invalid_request_error",
                code: "not_found",
            },
        });
    });
    // Error handler
    app.use((err, _req, res, _next) => {
        console.error("[Server Error]:", err.message);
        res.status(500).json({
            error: {
                message: err.message,
                type: "server_error",
                code: null,
            },
        });
    });
    return app;
}
/**
 * Start the HTTP server
 */
export async function startServer(config) {
    const { port, host = "127.0.0.1" } = config;
    if (serverInstance) {
        console.log("[Server] Already running, returning existing instance");
        return serverInstance;
    }
    const app = createApp();
    return new Promise((resolve, reject) => {
        serverInstance = createServer(app);
        serverInstance.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                reject(new Error(`Port ${port} is already in use`));
            }
            else {
                reject(err);
            }
        });
        serverInstance.listen(port, host, () => {
            console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
            console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
            resolve(serverInstance);
        });
    });
}
/**
 * Stop the HTTP server
 */
export async function stopServer() {
    if (!serverInstance)
        return;
    return new Promise((resolve, reject) => {
        serverInstance.close((err) => {
            if (err) {
                reject(err);
            }
            else {
                console.log("[Server] Stopped");
                serverInstance = null;
                resolve();
            }
        });
    });
}
/**
 * Get the current server instance
 */
export function getServer() {
    return serverInstance;
}
//# sourceMappingURL=index.js.map