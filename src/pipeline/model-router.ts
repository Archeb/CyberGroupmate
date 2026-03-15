/**
 * phase6/model-router.ts — 事件→模型路由
 *
 * 根据事件的复杂度和特征，选择合适的 LLM 模型。
 *
 * 路由逻辑：
 * - 直接 @ / 私聊 / 复杂问题 → SOTA 模型
 * - 一般介入（问答、知识补充）→ Mid-tier 模型
 * - 简单场景（闲聊、共识总结）→ Cheap 模型
 */

import { createLogger } from "../core/logger.js";
import type { LLMConfig } from "../core/llm.js";
import type {
    Message,
    TriageDecision,
    ModelRouteResult,
    ModelRouteRule,
    InterventionType,
} from "./types.js";

const log = createLogger("model-router");

// ─── 默认路由规则 ───

const DEFAULT_RULES: ModelRouteRule[] = [
    {
        name: "direct_mention_complex",
        match: { isDirect: true, isComplex: true },
        route: { model: "sota" },
    },
    {
        name: "direct_mention_simple",
        match: { isDirect: true },
        route: { model: "mid" },
    },
    {
        name: "factual_correction",
        match: { interventionType: ["FACTUAL_CORRECTION"] },
        route: { model: "mid" },
    },
    {
        name: "question_answer",
        match: {
            interventionType: ["QUESTION_ANSWER", "KNOWLEDGE_GAP"],
            confidenceRange: [0.7, 1.0],
        },
        route: { model: "mid" },
    },
    {
        name: "resource_sharing",
        match: { interventionType: ["RESOURCE_SHARING"] },
        route: { model: "mid" },
    },
    {
        name: "conflict_mediation",
        match: { interventionType: ["CONFLICT_MEDIATION"] },
        route: { model: "sota" },
    },
    {
        name: "casual_chat",
        match: { interventionType: ["CASUAL_CHAT", "CONSENSUS_SUMMARY"] },
        route: { model: "cheap" },
    },
];

// ─── 模型名称映射 ───

interface ModelTierConfig {
    cheap: string;
    mid: string;
    sota: string;
}

const DEFAULT_MODEL_TIERS: ModelTierConfig = {
    cheap: "",
    mid: "",
    sota: "",
};

/**
 * ModelRouter — 事件→模型路由器
 */
export class ModelRouter {
    private rules: ModelRouteRule[];
    private modelTiers: ModelTierConfig;

    constructor(
        private baseLLMConfig: LLMConfig,
        rules?: ModelRouteRule[],
        modelTiers?: Partial<ModelTierConfig>,
    ) {
        this.rules = rules ?? DEFAULT_RULES;
        this.modelTiers = {
            cheap: modelTiers?.cheap ?? baseLLMConfig.model,
            mid: modelTiers?.mid ?? baseLLMConfig.model,
            sota: modelTiers?.sota ?? baseLLMConfig.model,
        };
    }

    /**
     * 路由决策
     *
     * @param isDirect 是否为直接交互（@/回复/私聊）
     * @param triageDecision Triage 结果（可选，FAST_PATH 时无）
     * @param messages 触发消息列表
     */
    route(
        isDirect: boolean,
        triageDecision?: TriageDecision,
        messages?: Message[]
    ): ModelRouteResult {
        const isComplex = this.assessComplexity(messages ?? [], triageDecision);

        for (const rule of this.rules) {
            if (this.matchesRule(rule, isDirect, isComplex, triageDecision)) {
                const modelName = this.resolveModelName(rule.route.model);
                log.debug("路由匹配", {
                    rule: rule.name,
                    model: modelName,
                });
                return {
                    model: modelName,
                    overrides: { model: modelName },
                };
            }
        }

        // 默认：mid
        const fallbackModel = this.modelTiers.mid;
        log.debug("路由回退", { model: fallbackModel });
        return {
            model: fallbackModel,
            overrides: { model: fallbackModel },
        };
    }

    /**
     * 规则匹配
     */
    private matchesRule(
        rule: ModelRouteRule,
        isDirect: boolean,
        isComplex: boolean,
        decision?: TriageDecision
    ): boolean {
        const m = rule.match;

        if (m.isDirect !== undefined && m.isDirect !== isDirect) return false;
        if (m.isComplex !== undefined && m.isComplex !== isComplex) return false;

        if (m.interventionType && decision) {
            if (!m.interventionType.includes(decision.intervention_type)) return false;
        } else if (m.interventionType && !decision) {
            return false;
        }

        if (m.confidenceRange && decision) {
            if (decision.confidence < m.confidenceRange[0] || decision.confidence > m.confidenceRange[1]) {
                return false;
            }
        }

        return true;
    }

    /**
     * 复杂度评估
     */
    private assessComplexity(messages: Message[], decision?: TriageDecision): boolean {
        if (messages.length === 0) return false;

        let score = 0;

        // 消息长度
        const avgLength = messages.reduce((sum, m) => sum + m.text.length, 0) / messages.length;
        if (avgLength > 100) score += 2;
        if (avgLength > 200) score += 1;

        // 是否含问题
        const hasQuestion = messages.some(m => m.text.includes("?") || m.text.includes("？"));
        if (hasQuestion) score += 1;

        // 多人讨论
        const uniqueSenders = new Set(messages.map(m => m.senderId)).size;
        if (uniqueSenders >= 3) score += 2;

        // 高置信度介入
        if (decision && decision.confidence > 0.85) score += 1;

        // 需要事实纠正或冲突调解
        if (decision?.intervention_type === "FACTUAL_CORRECTION") score += 1;
        if (decision?.intervention_type === "CONFLICT_MEDIATION") score += 2;

        return score >= 4;
    }

    /**
     * 解析模型层级名到实际模型名
     */
    private resolveModelName(tier: string): string {
        switch (tier) {
            case "cheap":
                return this.modelTiers.cheap;
            case "mid":
                return this.modelTiers.mid;
            case "sota":
                return this.modelTiers.sota;
            default:
                // 如果不是层级名，当作实际模型名
                return tier;
        }
    }
}
