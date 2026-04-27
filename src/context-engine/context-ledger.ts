/**
 * context-engine/context-ledger.ts — 已提交上下文的状态追踪
 *
 * 类比前端的 committed fiber tree：
 * 记录"LLM 当前已经看到了什么"（结构化数据层面），
 * 用于下次 render 时计算 delta。
 */

import type { CommittedSection } from "./types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("context-ledger");

export class ContextLedger {
    /** section name → 已提交状态 */
    private sections = new Map<string, CommittedSection>();

    private buildKey(sectionName: string, scopeKey?: string): string {
        return scopeKey ? `${sectionName}@@${scopeKey}` : sectionName;
    }

    /**
     * 获取某个 section 的已提交数据。
     * 返回 null 表示该 section 从未被提交过（首次渲染）。
     */
    getCommitted(sectionName: string, scopeKey?: string): CommittedSection | null {
        return this.sections.get(this.buildKey(sectionName, scopeKey)) ?? null;
    }

    /**
     * 提交一个 section 的当前数据到 ledger。
     * 在 LLM 调用成功后调用。
     */
    commit(sectionName: string, data: unknown, hash: string, scopeKey?: string): void {
        this.sections.set(this.buildKey(sectionName, scopeKey), {
            data,
            hash,
            committedAt: Date.now(),
        });
    }

    /**
     * 重置所有追踪状态。
     * 在 conversation history compaction 后调用——
     * 因为 compaction 改变了 LLM 已知的上下文，需要回退到全量发送。
     */
    reset(): void {
        const size = this.sections.size;
        this.sections.clear();
        if (size > 0) {
            log.info("ledger reset", { clearedSections: size });
        }
    }

    /**
     * 移除单个 section 的追踪状态。
     * 用于某个 section 的数据源失效时。
     */
    invalidate(sectionName: string, scopeKey?: string): boolean {
        return this.sections.delete(this.buildKey(sectionName, scopeKey));
    }

    /** 当前追踪的 section 数量 */
    get size(): number {
        return this.sections.size;
    }

    /** 获取所有已提交 section 的名称列表（调试用） */
    getCommittedNames(): string[] {
        return [...this.sections.keys()];
    }

    /** 导出快照（持久化/调试用） */
    toSnapshot(): Record<string, { hash: string; committedAt: number }> {
        const result: Record<string, { hash: string; committedAt: number }> = {};
        for (const [name, section] of this.sections) {
            result[name] = { hash: section.hash, committedAt: section.committedAt };
        }
        return result;
    }
}
