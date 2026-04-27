/**
 * context-engine/types.ts — Context Engine 核心类型定义
 *
 * 设计哲学：结构化数据 = source of truth，自然语言渲染 = 视图层。
 * 类比前端 Virtual DOM：数据层做 diff，渲染只发生一次在最末端。
 */

// ═══ Section 缓存策略 ═══

/** 缓存策略：决定如何对比当前数据与已提交数据 */
export type CacheStrategy =
    /** 极少变化，hash 对比，不变就复用上次渲染 */
    | "static"
    /** 增量追踪，由 provider.diff() 在结构化层计算 delta */
    | "delta"
    /** 每次发送完整快照，不做 diff */
    | "snapshot"
    /** 完全不缓存，每次重新获取和渲染 */
    | "volatile";

/** 历史存储策略：决定渲染结果如何进入 conversationHistory */
export type HistoryStrategy =
    /** 完整渲染结果进入历史 */
    | "persistent"
    /** 仅增量部分进入历史（配合 cache="delta"） */
    | "delta-only"
    /** 不进入历史，仅出现在当前请求中 */
    | "ephemeral"
    /** 进入历史但替换为占位符 */
    | "omit";

// ═══ Section Schema ═══

/** Section 的元数据声明 */
export interface SectionSchema {
    /** 唯一标识符 */
    name: string;
    /** Dashboard 显示的人类可读名称 */
    label: string;
    /** 数据来源描述（用于文档和 Dashboard 展示） */
    source: string;
    /** 缓存策略 */
    cache: CacheStrategy;
    /** 历史存储策略 */
    history: HistoryStrategy;
}

// ═══ Delta 统计 ═══

/** 增量计算的统计信息 */
export interface DeltaStats {
    /** 当前总数据项数 */
    total: number;
    /** 新增的数据项数 */
    added: number;
    /** 未变化的数据项数 */
    unchanged: number;
}

/** diff() 的返回值 */
export interface DiffResult<T> {
    /** 完整数据 */
    full: T;
    /** 仅增量部分 */
    delta: T;
    /** 统计信息 */
    stats: DeltaStats;
}

// ═══ Resolve Context ═══

/**
 * ResolveContext — 传递给 provider.resolve() 的上下文
 *
 * 携带所有可能的依赖和数据源，provider 按需取用。
 * 采用纯函数式设计：provider 不通过闭包捕获依赖，而是从 ctx 中获取。
 */
export interface ResolveContext {
    /** 当前 chatId */
    chatId?: string;
    /** 所有可用的数据源 — provider 按 key 取用 */
    [key: string]: unknown;
}

// ═══ Section Provider ═══

/**
 * SectionProvider — 单个 section 的数据提供者
 *
 * 每个 provider 是一个完整的 "数据 → 渲染" 管线：
 * 1. resolve(): 从上下文中提取结构化数据
 * 2. diff(): 在结构化层计算增量（仅 delta 类型需要）
 * 3. render(): 将结构化数据渲染为自然语言文本
 * 4. renderDelta(): 将增量数据渲染为文本（仅 delta-only history 需要）
 * 5. hash(): 计算数据的 identity（仅 static cache 需要）
 *
 * 增量逻辑由数据源模块自己实现，因为只有它知道自己的数据结构。
 */
export interface SectionProvider<T = unknown> {
    /** Section 元数据 */
    schema: SectionSchema;

    /**
     * 计算该 section 在 ledger 中的作用域键。
     * 用于共享引擎中的状态隔离，例如按 chatId 分开追踪 delta/static cache。
     * 返回 undefined 表示使用全局作用域。
     */
    scopeKey?(ctx: ResolveContext, data: T): string | undefined;

    /**
     * 从 ResolveContext 中提取结构化数据。
     * 返回 null/undefined 表示此 section 不应出现（相当于 condition=false）。
     */
    resolve(ctx: ResolveContext): T | null | undefined;

    /**
     * 在结构化层计算当前数据与已提交数据的增量。
     * 仅 cache="delta" 的 provider 需要实现。
     * committed 为 null 表示首次（ledger 中无记录），此时 delta 应等于 full。
     */
    diff?(current: T, committed: T | null): DiffResult<T>;

    /**
     * 将完整结构化数据渲染为自然语言文本。
     * 这是"视图层"——所有渲染逻辑集中在这里，只调用一次。
     */
    render(data: T): string;

    /**
     * 将增量数据渲染为自然语言文本。
     * 仅 history="delta-only" 的 provider 需要实现。
     * 用于生成存入 conversationHistory 的精简版本。
     */
    renderDelta?(delta: T): string;

    /**
     * 计算数据的 identity hash。
     * 仅 cache="static" 的 provider 需要实现。
     * 用于判断数据是否发生变化。
     */
    hash?(data: T): string;
}

// ═══ Section Node（虚拟上下文树节点） ═══

/**
 * SectionNode — 虚拟上下文树中的一个节点
 *
 * 对应一次 render 中某个 provider 的解析结果。
 * 类比 React 中的 Virtual DOM 节点。
 */
export interface SectionNode {
    /** Section 元数据 */
    schema: SectionSchema;
    /** ledger 作用域键（如 chatId） */
    scopeKey?: string;
    /** 结构化数据（source of truth） */
    data: unknown;
    /** 完整渲染文本（发给 LLM） */
    fullRendered: string;
    /** 存入历史的文本（根据 history 策略可能是 delta/omit/null） */
    historicalRendered: string | null;
    /** 是否有实质内容变化（相对于 ledger 中的已提交数据） */
    changed: boolean;
    /** 增量统计（仅 delta 类型有值） */
    deltaStats?: DeltaStats;
    /** 是否因 resolve() 返回 null 而被跳过 */
    skipped: boolean;
}

// ═══ Render Result ═══

/**
 * RenderResult — ContextEngine.render() 的完整输出
 */
export interface RenderResult {
    /** 进入历史的内容（persistent + delta-only + omit 部分） */
    historicalContent: string;
    /** 仅当前请求的内容（ephemeral 部分，拼在同一条 user message 末尾） */
    ephemeralContent: string;
    /** Dashboard 可视化数据 */
    manifest: ContextManifest;
    /** 虚拟上下文树快照（供 commit() 使用） */
    tree: SectionNode[];
}

// ═══ Context Manifest（Dashboard 可视化） ═══

/** 单个 section 的渲染报告 */
export interface SectionManifestEntry {
    /** Section 名称 */
    name: string;
    /** 人类可读标签 */
    label: string;
    /** 数据来源 */
    source: string;
    /** 缓存策略 */
    cache: CacheStrategy;
    /** 历史策略 */
    history: HistoryStrategy;
    /** 本次渲染的字符数 */
    renderedChars: number;
    /** 估算 token 数 */
    estimatedTokens: number;
    /** 是否有变化 */
    changed: boolean;
    /** 是否被跳过 */
    skipped: boolean;
    /** 增量统计 */
    deltaStats?: DeltaStats;
    /** 本轮实际发进 LLM 当前消息的内容（无内容则为 null） */
    sentContent: string | null;
    /** 内容预览（前 200 字符） */
    contentPreview: string;
}

/** 完整的上下文渲染报告 */
export interface ContextManifest {
    /** 渲染时间 */
    timestamp: string;
    /** 关联的 chatId */
    chatId?: string;
    /** 引擎标识（如 "attend", "executor", "pipeline"） */
    engineId: string;
    /** 各 section 的渲染报告 */
    sections: SectionManifestEntry[];
    /** 汇总统计 */
    summary: {
        totalSections: number;
        activeSections: number;
        skippedSections: number;
        totalChars: number;
        historicalChars: number;
        ephemeralChars: number;
        estimatedTokens: number;
    };
}

// ═══ Committed State（Ledger 内部） ═══

/** Ledger 中一个 section 的已提交状态 */
export interface CommittedSection {
    /** 上次提交的结构化数据（用于 diff） */
    data: unknown;
    /** 数据的 hash（用于 static cache 比较） */
    hash: string;
    /** 提交时间 */
    committedAt: number;
}
