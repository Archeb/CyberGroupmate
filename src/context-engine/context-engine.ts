/**
 * context-engine/context-engine.ts — 声明式 Prompt 组装引擎
 *
 * 核心流程：
 * 1. providers 按注册顺序 resolve() 结构化数据
 * 2. 对每个 provider 按 cache 策略在数据层做 diff
 * 3. 对每个 provider 按 history 策略分离 persistent/ephemeral
 * 4. 一次性 render() 为自然语言文本
 * 5. 组装最终的 historicalContent + ephemeralContent
 * 6. 生成 ContextManifest 供 Dashboard 可视化
 *
 * 调用者在 LLM 成功后调用 commit() 将当前树提交到 ledger。
 */

import type {
    SectionProvider,
    SectionNode,
    RenderResult,
    ContextManifest,
    SectionManifestEntry,
    ResolveContext,
    DeltaStats,
} from "./types.js";
import { ContextLedger } from "./context-ledger.js";
import { createLogger } from "../core/logger.js";
import { EventEmitter } from "node:events";

const log = createLogger("context-engine");

/**
 * 模块级事件发射器 — Dashboard event-bridge 订阅用。
 * - `context:manifest` → ContextManifest（每次 render 后触发）
 */
export const contextEvents = new EventEmitter();
contextEvents.setMaxListeners(20);

/** 粗略估算 token 数（中英文混合，平均 2 字符/token） */
function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 2);
}

export class ContextEngine {
    /** 引擎标识（用于 manifest 和日志） */
    readonly engineId: string;
    /** 已提交状态追踪 */
    readonly ledger: ContextLedger;
    /** 注册的 providers（有序，决定渲染顺序） */
    private providers: SectionProvider[] = [];

    constructor(engineId: string, ledger?: ContextLedger) {
        this.engineId = engineId;
        this.ledger = ledger ?? new ContextLedger();
    }

    /**
     * 注册一个数据提供者。
     * 注册顺序决定最终渲染的 section 顺序。
     */
    register(provider: SectionProvider): this {
        // 验证 delta provider 必须实现 diff
        if (provider.schema.cache === "delta" && !provider.diff) {
            throw new Error(
                `Provider "${provider.schema.name}" has cache="delta" but does not implement diff()`
            );
        }
        // 验证 delta-only history 必须实现 renderDelta
        if (provider.schema.history === "delta-only" && !provider.renderDelta) {
            throw new Error(
                `Provider "${provider.schema.name}" has history="delta-only" but does not implement renderDelta()`
            );
        }
        // 验证 static cache 必须实现 hash
        if (provider.schema.cache === "static" && !provider.hash) {
            throw new Error(
                `Provider "${provider.schema.name}" has cache="static" but does not implement hash()`
            );
        }
        this.providers.push(provider);
        return this;
    }

    /**
     * 批量注册多个 providers。
     */
    registerAll(providers: SectionProvider[]): this {
        for (const p of providers) this.register(p);
        return this;
    }

    /**
     * 清除所有已注册的 providers。
     * 用于重新配置引擎时。
     */
    clearProviders(): void {
        this.providers = [];
    }

    /**
     * 渲染一次完整的上下文。
     *
     * 遍历所有 providers，对每个：
     * 1. resolve() → 结构化数据（null 则跳过）
     * 2. 按 cache 策略 diff → 确定 changed 状态和 delta
     * 3. render()/renderDelta() → 自然语言文本
     * 4. 按 history 策略分离 historical/ephemeral
     */
    render(ctx: ResolveContext): RenderResult {
        const tree: SectionNode[] = [];

        for (const provider of this.providers) {
            try {
                const node = this.renderSection(provider, ctx);
                tree.push(node);
            } catch (err) {
                log.error(`Provider "${provider.schema.name}" failed`, {
                    error: err instanceof Error ? err.message : String(err),
                });
                // 失败的 section 标记为 skipped，不阻塞其他 section
                tree.push({
                    schema: provider.schema,
                    data: null,
                    fullRendered: "",
                    historicalRendered: null,
                    changed: false,
                    skipped: true,
                });
            }
        }

        const result = this.assemble(tree, ctx.chatId as string | undefined);

        // 广播 manifest 到 dashboard
        if (contextEvents.listenerCount("context:manifest") > 0) {
            contextEvents.emit("context:manifest", result.manifest);
        }

        return result;
    }

    /**
     * 将渲染结果提交到 ledger。
     * 在 LLM 调用成功后调用——只有成功发送给 LLM 的数据才算"已提交"。
     */
    commit(tree: SectionNode[]): void {
        for (const node of tree) {
            if (node.skipped || node.data == null) continue;

            const provider = this.providers.find(p => p.schema.name === node.schema.name);
            const hash = provider?.hash
                ? provider.hash(node.data)
                : this.defaultHash(node.data);

            this.ledger.commit(node.schema.name, node.data, hash, node.scopeKey);
        }
        log.debug("committed", {
            engineId: this.engineId,
            sections: tree.filter(n => !n.skipped).map(n => ({
                name: n.schema.name,
                scopeKey: n.scopeKey,
            })),
        });
    }

    /**
     * 渲染单个 section。
     */
    private renderSection(provider: SectionProvider, ctx: ResolveContext): SectionNode {
        const { schema } = provider;

        // 1. resolve：获取结构化数据
        const data = provider.resolve(ctx);
        if (data == null) {
            return {
                schema,
                scopeKey: undefined,
                data: null,
                fullRendered: "",
                historicalRendered: null,
                changed: false,
                skipped: true,
            };
        }

        const scopeKey = provider.scopeKey?.(ctx, data);

        // 2. diff：在结构化层比较
        const committed = this.ledger.getCommitted(schema.name, scopeKey);
        let changed = true;
        let deltaData: unknown = data;
        let deltaStats: DeltaStats | undefined;

        switch (schema.cache) {
            case "static": {
                const currentHash = provider.hash!(data);
                changed = currentHash !== committed?.hash;
                break;
            }
            case "delta": {
                const result = provider.diff!(data, committed?.data ?? null);
                deltaData = result.delta;
                deltaStats = result.stats;
                changed = result.stats.added > 0;
                break;
            }
            case "snapshot":
            case "volatile":
                // 每次都视为 changed，发送完整数据
                changed = true;
                break;
        }

        // 3. render：结构化数据 → 自然语言（视图层，一次性）
        const fullRendered = provider.render(data);

        // 4. 按 history 策略生成历史版本
        let historicalRendered: string | null;
        switch (schema.history) {
            case "persistent":
                historicalRendered = fullRendered;
                break;
            case "delta-only":
                historicalRendered = changed ? provider.renderDelta!(deltaData) : null;
                break;
            case "omit":
                historicalRendered = `[${schema.label}: 见最新版本]`;
                break;
            case "ephemeral":
                historicalRendered = null;
                break;
        }

        return {
            schema,
            scopeKey,
            data,
            fullRendered,
            historicalRendered,
            changed,
            deltaStats,
            skipped: false,
        };
    }

    /**
     * 将虚拟上下文树组装为最终输出。
     *
     * - 非 ephemeral sections 的 fullRendered → 拼入发送给 LLM 的内容
     * - ephemeral sections 的 fullRendered → 拼入 ephemeralContent（附在同一条消息末尾）
     * - historicalRendered → 拼入 historicalContent（存入 conversationHistory）
     */
    private assemble(tree: SectionNode[], chatId?: string): RenderResult {
        const historicalParts: string[] = [];
        const ephemeralParts: string[] = [];

        for (const node of tree) {
            if (node.skipped || !node.fullRendered) continue;

            if (node.schema.history === "ephemeral") {
                ephemeralParts.push(node.fullRendered);
            } else {
                // 非 ephemeral 的内容也在 ephemeral 中不出现
                // historicalRendered 用于存入历史
                if (node.historicalRendered) {
                    historicalParts.push(node.historicalRendered);
                }
            }
        }

        const historicalContent = historicalParts.join("\n\n");
        const ephemeralContent = ephemeralParts.join("\n\n");

        const manifest = this.buildManifest(tree, chatId);

        return { historicalContent, ephemeralContent, manifest, tree };
    }

    /**
     * 构建 Dashboard 可视化 manifest。
     */
    private buildManifest(tree: SectionNode[], chatId?: string): ContextManifest {
        const sentOrderMap = new Map<SectionNode, { order: number; phase: "historical" | "ephemeral" }>();
        const historicalNodes = tree.filter(node =>
            !node.skipped &&
            node.schema.history !== "ephemeral" &&
            !!node.historicalRendered
        );
        const ephemeralNodes = tree.filter(node =>
            !node.skipped &&
            node.schema.history === "ephemeral" &&
            !!node.fullRendered
        );

        [...historicalNodes, ...ephemeralNodes].forEach((node, index) => {
            sentOrderMap.set(node, {
                order: index,
                phase: node.schema.history === "ephemeral" ? "ephemeral" : "historical",
            });
        });

        const sections: SectionManifestEntry[] = tree.map(node => ({
            ...(sentOrderMap.has(node)
                ? {
                    sentPhase: sentOrderMap.get(node)!.phase,
                    sentOrder: sentOrderMap.get(node)!.order,
                }
                : {
                    sentPhase: "none" as const,
                    sentOrder: null,
                }),
            name: node.schema.name,
            label: node.schema.label,
            source: node.schema.source,
            cache: node.schema.cache,
            history: node.schema.history,
            renderedChars: node.fullRendered.length,
            estimatedTokens: estimateTokens(node.fullRendered),
            changed: node.changed,
            skipped: node.skipped,
            deltaStats: node.deltaStats,
            sentContent: node.skipped
                ? null
                : node.schema.history === "ephemeral"
                    ? node.fullRendered
                    : node.historicalRendered,
            contentPreview: node.fullRendered.slice(0, 200),
        }));

        const activeNodes = tree.filter(n => !n.skipped);
        const totalChars = activeNodes.reduce((s, n) => s + n.fullRendered.length, 0);
        const historicalChars = activeNodes
            .filter(n => n.historicalRendered)
            .reduce((s, n) => s + (n.historicalRendered?.length ?? 0), 0);
        const ephemeralChars = activeNodes
            .filter(n => n.schema.history === "ephemeral")
            .reduce((s, n) => s + n.fullRendered.length, 0);

        return {
            timestamp: new Date().toISOString(),
            chatId,
            engineId: this.engineId,
            sections,
            summary: {
                totalSections: tree.length,
                activeSections: activeNodes.length,
                skippedSections: tree.length - activeNodes.length,
                totalChars,
                historicalChars,
                ephemeralChars,
                estimatedTokens: estimateTokens(
                    activeNodes.map(n => n.fullRendered).join("")
                ),
            },
        };
    }

    /**
     * 默认 hash 实现（用于没有自定义 hash 的 provider）。
     * 取内容长度 + 前 100 字符作为简单指纹。
     */
    private defaultHash(data: unknown): string {
        const str = JSON.stringify(data);
        return `${str.length}:${str.slice(0, 100)}`;
    }

    /**
     * 获取当前注册的 provider 列表（调试用）。
     */
    getProviderNames(): string[] {
        return this.providers.map(p => p.schema.name);
    }
}
