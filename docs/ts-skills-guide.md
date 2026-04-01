# TS Skills (Pure Worker Modules) 动态挂载开发指南

> 本指南介绍 Sandbox 中 **TS Skills** 的架构机制，以及如何为 Agent 编写和挂载自定义的纯净 TypeScript 能力扩展。

## 1. 核心概念与定位

CyberGroupmate 的 Sandbox 模块系统被划分为两大阵营：

1. **Host-coupled Modules（框架核心能力）**
   - **特点**：与主框架、数据库通信或平台协议强绑定（如 `memory`, `actions`, `telegram`）。
   - **机制**：由主框架硬编码实现，通过 IPC (`callHost`) 穿透沙盒边界，与主进程通信。
   - **位置**：代码存在于 `src/sandbox/modules/` 中。

2. **Pure Worker Modules / TS Skills（纯净外挂能力）**
   - **特点**：完全在 Sandbox Worker 独立进程内运行。通常是对外部 HTTP REST API、第三方 SaaS 或本地数据处理脚本的封装（如 GitHub API、Twitter发推、网页抓取等）。
   - **机制**：通过 Node.js 原生运行，支持标准 `npm` 依赖包。无需与 CyberGroupmate 主进程通信。
   - **位置**：用户在根目录下的 `workspace/skills/` 文件夹中动态挂载。

---

## 2. 快速开始与目录结构

所有 TS Skills 皆通过统一约定放置在根目录的 `workspace/skills/` 下。框架在每次 Sandbox Worker 启动时都会扫描此目录。

### 快速开始 (推荐)
你可以直接以官方模板仓库 [Archeb/skills](https://github.com/Archeb/skills) 作为起点。

1. **直接克隆**：如果你只想基于现有模板使用，可以直接把它 clone 到你的本地：
   ```bash
   git clone https://github.com/Archeb/skills workspace/skills
   ```
2. **Fork 后定制**：你可以先在 GitHub 上 Fork 这个仓库，在里面添加你自己需要的新模块（Skills），然后再将你自己 Fork 的仓库 clone 到 `workspace/skills` 目录下使用。这种方式可以让你方便地使用 Git 维护属于你自己的专属能力库。

### 目录结构约定
无论你是 clone 模板还是从零开始写，你的 `workspace/skills/` 应当保持如下结构：

```text
workspace/skills/
├── github/                 # Skill 名称（如 "github" 将被挂载至全局变量 "github" 或 "ctx.github"）
│   ├── index.ts            # 运行时实现：出口需要是实例化后的 API 代理对象
│   └── github.d.ts         # 类型定义文件：包含供 LLM 查阅的 JSDoc 文档
├── twitter/
│   ├── index.ts
│   └── twitter.d.ts
└── package.json            # 放置所有外挂 Skill 所需的 NPM 依赖
```

---

## 3. 编写一个 TS Skill (以 GitHub 为例)

### 3.1 编写运行时实现 (`index.ts`)

`index.ts` 负责实际的运行逻辑。它必须默认导出（`export default`）一个对象，或者导出一个与目录名同名的变量（`export const github = { ... }`）。

你可以在这里使用任何标准 Node.js 库结构，通过 `process.env` 获取环境变量（Sandbox 进程继承这些变量）。

```typescript
// workspace/skills/github/index.ts
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

export default {
    listIssues: async (owner: string, repo: string, opts?: { state?: string }) => {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
            headers: {
                "Accept": "application/vnd.github+json",
                "Authorization": GITHUB_TOKEN ? `Bearer ${GITHUB_TOKEN}` : "",
                "User-Agent": "CyberGroupmate-Sandbox"
            }
        });
        return res.json();
    },
    
    createIssue: async (owner: string, repo: string, title: string, body: string) => {
        // ... 具体实现
    }
};
```

### 3.2 编写 Agent 可见类定义 (`*.d.ts`)

为了防止大模型产生 API 幻觉，并且配合 **Two-pass Code Generation** 流程，必须提供一个精确定义的 `.d.ts` 文件。该文件将告诉 LLM 这个能力到底怎么调用。

```typescript
// workspace/skills/github/github.d.ts

interface GitHubIssue {
    number: number;
    title: string;
    state: "open" | "closed";
    html_url: string;
}

/** 
 * GitHub API 客户端
 * 可用于查询和创建 issue
 */
declare const github: {
    /**
     * 列出仓库的 Issue
     * @param owner 仓库所有者 (如 "octocat")
     * @param repo 仓库名称 (如 "Hello-World")
     * @param opts 过滤参数
     * @example
     * const issues = await github.listIssues("octocat", "Hello-World", { state: "open" });
     */
    listIssues(owner: string, repo: string, opts?: { state?: "open" | "closed" }): Promise<GitHubIssue[]>;

    /**
     * 创建新 Issue
     * @param title Issue 标题
     * @param body Markdown 内容
     */
    createIssue(owner: string, repo: string, title: string, body: string): Promise<GitHubIssue>;
};
```

> **划重点**：这里的 `.d.ts` 主要服务于人（写 Agent Prompt）和 LLM（读 API 文档）。务必提供详细的 JSDoc，特别是加上 `@example`，这能极大幅度提升它编写调用代码的第一把成功率。

---

## 4. Lifecycle 与工作流

框架按以下三个维度支撑 TS Skills 到大模型的注入闭环。

### 4.1 预热与依赖
任何用到第三方库（如 `npm install @octokit/rest`）的 Skill，只需在 `workspace/skills/package.json` 添加依赖并自行 `npm install`。Sandbox Worker 启动时可以毫无阻碍地 `require / import` 这些包。

### 4.2 纯动态文档解析与 Two-Pass 类型推断
你**无需**为了 TS Skills 执行任何文档生成命令（`npm run gen:module-docs` 仅针对框架自带的核心接口）。框架在每次运行时会自动读取并解析文档：

- 扫描机制：`skill-loader.ts` 会在运行时自动扫描 `workspace/skills/` 目录下带有 `.d.ts` 后缀的文件，并用正则表达式提取其中方法的 JSDoc 注释。
- 注入原理：在 LLM 生成代码阶段（Two-pass第一阶段），如果意图提取器通过正则表达式检测到了类似 `github.listIssues(...)`，框架会自动将该方法完整的 TypeDoc 动态提取出并注入上下文告知大模型重试。

### 4.3 动态挂载机制 (Hot Mounting)
当你启动系统时，`sandbox-worker.ts` 将执行以下动作：
1. `skill-loader.ts` 扫描 `workspace/skills/` 并逐个 `await import()` 入口。
2. 防雪崩捕捉：若 `twitter` skill 配置失败崩溃，它不会阻断 `github` 的加载与整体 Worker 的启动。
3. 这些载入成功的变量以动态传参 `new Function("ctx", "github", "twitter", ...)` 的形式暴露在 Agent 执行的上下文中。
4. 被挂载的函数会自动应用 `PromiseTracker` 包装，以防范大模型忘写 `await` 导致的异步生命周期逃逸。

---

## 5. 常见问题 (FAQ)

**Q：TS Skills 里的代码不安全，可能执行任意脚本吗？**
A：是的。TS Skills 本身就是赋予系统高度定制权的 Node.js 插件。它在执行权限上近乎等同于主服务。所有的沙盒隔离只防御 Agent 实时生成的随机代码，不对由系统管理员（你）显式部署在工作区的依赖包做底层文件权限锁定。

**Q：如果我在编写 index.ts 或 .d.ts 时改了代码，系统会热更新吗？**
A：Sandbox Worker 本质是持续运行的长连接进程。如果你修改了 `index.ts` 的逻辑代码，或者是修改了 `.d.ts` 提供给 LLM 的注释，你都只需要**触发 Sandbox Worker 进程重启**方可重新动态加载，无须手动运行任何编译脚本。

**Q：如果在 `index.ts` 里有复杂的 TypeScript 语法（如 Enum、Type Assertion），Worker 能够加载吗？**
A：框架已使用 `tsx`（TypeScript 执行器）接管了 Worker 的加载。因此你不仅能写标准的 ESM / CommonJS `index.js`，也可以直接零转译地使用现代 `index.ts` 语法进行加载。
