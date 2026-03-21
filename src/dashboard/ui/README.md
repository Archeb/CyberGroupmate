# CyberGroupmate Dashboard UI

基于 **Svelte 5 + Vite + TailwindCSS 4 + DaisyUI 5** 的 Dashboard 前端。

## 本地开发

```bash
# 1. 安装依赖
cd src/dashboard/ui
npm install

# 2. 启动后端 (主项目根目录)
npm run dev               # 后端运行在 :6767

# 3. 启动 Dashboard dev server (新终端)
npm run dashboard:dev     # Vite 运行在 :5173, 自动代理 /api 和 /ws 到 :6767

# 4. 浏览器访问
open http://localhost:5173/?token=<your-dashboard-token>
```

> VSCode: 也可以直接运行 `🖥️ Dashboard Dev Server (Vite)` Launch 配置。

## 生产构建

```bash
# 构建到 src/dashboard/public/
npm run dashboard:build
```

构建产物由 `dashboard-server.ts` 以 `express.static` 方式提供服务。

## Docker 部署

```bash
# 完整构建 (包含 dashboard UI build)
docker compose up --build -d

# 访问
# http://host:6767/?token=<your-dashboard-token>
```

Dockerfile 已配置 `ui-build` 阶段，自动在 Docker 构建期间编译 dashboard 前端。

## 项目结构

```
src/dashboard/ui/
├── index.html              # Vite 入口
├── package.json
├── vite.config.js          # 构建输出到 ../public/, dev 代理配置
├── svelte.config.js
└── src/
    ├── main.js             # Svelte 挂载入口
    ├── App.svelte          # 根组件 (Navbar + Tabs + Panels)
    ├── app.css             # 全局样式
    ├── lib/
    │   ├── api.js          # REST API 封装 (token 认证)
    │   ├── ws.js           # WebSocket 连接管理 (自动重连)
    │   ├── stores.js       # Svelte stores (全局状态)
    │   └── utils.js        # 工具函数 (escapeHtml, hljs, etc.)
    ├── components/
    │   ├── Navbar.svelte
    │   ├── StatsBar.svelte
    │   └── TabNav.svelte
    └── panels/
        ├── MessagesPanel.svelte
        ├── TopicsPanel.svelte
        ├── QueuePanel.svelte
        ├── DecisionsPanel.svelte
        ├── CodeActPanel.svelte
        ├── LLMLogPanel.svelte
        ├── MemoryPanel.svelte
        │   └── memory/
        │       ├── PersonsTab.svelte
        │       ├── ProfilesTab.svelte
        │       ├── GroupsTab.svelte
        │       ├── FactsTab.svelte
        │       ├── InteractionsTab.svelte
        │       └── RecallTab.svelte
        ├── StickersPanel.svelte
        ├── SystemPanel.svelte
        ├── TopicDetailPanel.svelte
        ├── EnqueueModal.svelte
        └── MemoryEditModal.svelte
```
