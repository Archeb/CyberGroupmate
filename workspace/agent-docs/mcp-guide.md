# MCP Server 使用指南

MCP (Model Context Protocol) 让你连接外部工具服务器，动态扩展可用能力。

## 连接 MCP Server

```typescript
const server = await mcp.connect({
    name: "filesystem",           // 名称（也是 tool 命名空间）
    command: "npx",               // 启动命令
    args: ["-y", "@anthropic/mcp-filesystem", "/workspace"],
    env: { /* 可选环境变量 */ },
});
console.log(server.tools); // [{ name: "read_file", description: "..." }, ...]
```

连接成功后，该 server 的所有 tools 会自动注入当前会话上下文，下一轮对话即可直接调用。

## 调用 Tool

两种方式：

```typescript
// 方式 1：通过连接返回值直接调用
const result = await server.call("read_file", { path: "/workspace/README.md" });

// 方式 2：通过 mcp.call 指定 server 名称
const result = await mcp.call("filesystem", "read_file", { path: "/workspace/README.md" });
```

## 查看已连接的 Servers

```typescript
const servers = mcp.list();
// [{ name: "filesystem", tools: ["read_file", "write_file", ...], running: true }]
```

## 断开连接

```typescript
await mcp.disconnect("filesystem");
```

断开后该 server 的 tools 从会话上下文中移除。

## 预配置（config.yaml）

在 `config.yaml` 中声明 MCP Server，Sandbox 启动时自动连接：

```yaml
mcp_servers:
  - name: filesystem
    command: npx
    args: ["-y", "@anthropic/mcp-filesystem"]
    auto_connect: true   # 默认 true
  - name: github
    command: npx
    args: ["-y", "@anthropic/mcp-github"]
    env:
      GITHUB_TOKEN: "ghp_xxx"
```

设置 `auto_connect: false` 的 server 不会自动连接，需要手动调用 `mcp.connect()`。

## 持久化

连接信息自动持久化到 `workspace/<chatId>/mcp-connections.json`。Worker 重启后自动重连。
