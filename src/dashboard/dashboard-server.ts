/**
 * dashboard-server.ts — Express + WebSocket 监控仪表盘服务器
 *
 * 嵌入到 main.ts，提供:
 * - REST API (/api/*) — 系统状态查询 + 干预
 * - WebSocket (/ws) — 实时事件推送
 * - 静态文件 (/) — SPA 前端
 *
 * Token 认证: 所有请求需携带 ?token=xxx 或 header Authorization: Bearer xxx
 */

import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardDeps, DashboardConfig } from "./types.js";
import { EventBridge } from "./event-bridge.js";
import { createApiRouter } from "./api-routes.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("dashboard");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class DashboardServer {
    private app: ReturnType<typeof express>;
    private server: ReturnType<typeof createServer>;
    private wss: WebSocketServer;
    private bridge: EventBridge;
    private config: DashboardConfig;

    constructor(deps: DashboardDeps, config: DashboardConfig) {
        this.config = config;
        this.app = express();
        this.server = createServer(this.app);
        this.wss = new WebSocketServer({ noServer: true });
        this.bridge = new EventBridge(deps);

        // JSON body parser
        this.app.use(express.json());

        // Token auth middleware
        this.app.use((req, res, next) => {
            // Skip auth for static files
            if (!req.path.startsWith("/api")) return next();
            const token = (req.query.token as string)
                || req.headers.authorization?.replace("Bearer ", "");
            if (token !== this.config.token) {
                return res.status(401).json({ error: "Unauthorized" });
            }
            next();
        });

        // API routes
        this.app.use("/api", createApiRouter(deps, this.bridge));

        // Webhook endpoint — 外部系统通过 POST /webhook/:path 触发 sandbox 代码
        // 无需 Token 认证（Webhook 由外部系统调用）
        this.app.post("/webhook/:path", async (req, res) => {
            const webhookPath = req.params.path;
            const request = {
                method: req.method,
                path: webhookPath,
                headers: req.headers,
                body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
                query: req.query,
            };

            // 在所有活跃 sandbox 中查找匹配的 webhook
            for (const { sandbox } of deps.sandboxPool.entries()) {
                try {
                    const result = await sandbox.handleWebhookRequest(webhookPath, request);
                    if (result !== null) {
                        res.status(200).json({ ok: true, output: result });
                        return;
                    }
                } catch (err) {
                    log.error("Webhook 执行失败", { path: webhookPath, error: String(err) });
                    res.status(500).json({ ok: false, error: String(err) });
                    return;
                }
            }

            res.status(404).json({ ok: false, error: `Webhook "${webhookPath}" not found` });
        });

        // Static files (SPA)
        this.app.use(express.static(join(__dirname, "public")));
        this.app.get("/", (_req, res) => {
            res.sendFile(join(__dirname, "public", "index.html"));
        });

        // WebSocket upgrade with token auth
        this.server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "", `http://localhost:${this.config.port}`);
            const token = url.searchParams.get("token");
            if (token !== this.config.token) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.wss.emit("connection", ws, request);
            });
        });

        this.wss.on("connection", (ws) => {
            log.info("WebSocket 客户端已连接");
            this.bridge.addClient(ws);

            // 处理来自前端的命令（如 llm:cancel）
            ws.on("message", (raw) => {
                try {
                    const msg = JSON.parse(String(raw));
                    if (msg && typeof msg.type === "string") {
                        this.bridge.handleCommand(msg);
                    }
                } catch { /* ignore non-JSON */ }
            });
        });
    }

    async start(): Promise<void> {
        const host = this.config.host ?? "127.0.0.1";
        return new Promise((resolve) => {
            this.server.listen(this.config.port, host, () => {
                const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
                log.info(`Dashboard 已启动: http://${displayHost}:${this.config.port} (listen ${host}:${this.config.port})`);
                resolve();
            });
        });
    }

    stop(): void {
        this.wss.close();
        this.server.close();
    }

    /** 获取 EventBridge (供外部广播事件) */
    getBridge(): EventBridge {
        return this.bridge;
    }
}
