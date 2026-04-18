/**
 * grounding-util.ts — 并行 Grounding（联网事实查证）工具
 *
 * 支持两个 Provider：
 * - Google Gemini (googleSearch tool)
 * - Grok xAI (web_search via Responses API)
 *
 * 设计原则：
 * 1. 对话内容先经过隐私过滤（人名替换为 User N，去除 @mention，去除时间戳）
 * 2. 与 attend-handler 的 LLM 决策并行执行
 * 3. 严格 Guardrail：无联网搜索证据则丢弃结果
 */

import { GoogleGenAI } from "@google/genai";
import type { GroundingConfig } from "../core/config.js";
import { renderPrompt } from "./prompt-renderer.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("grounding");

// ─── 隐私过滤 ───

/**
 * 对消息文本进行隐私脱敏：
 * - 收集所有 displayName，映射为 User 1, User 2 ...
 * - 去除所有 @mention
 * - 去除时间戳（常见格式，如 [2024-01-01 12:00] 或 HH:MM）
 */
export function sanitizeForGrounding(
    messagesText: string,
    activePersons?: Array<{ displayName: string; userId?: string; username?: string }>,
): string {
    let text = messagesText;

    // 1. 收集所有出现的人名并建立映射
    const nameMap = new Map<string, string>();
    let counter = 1;

    if (activePersons?.length) {
        for (const p of activePersons) {
            if (p.displayName && !nameMap.has(p.displayName)) {
                nameMap.set(p.displayName, `User ${counter++}`);
            }
            // 也替换 username
            if (p.username && !nameMap.has(p.username)) {
                nameMap.set(p.username, nameMap.get(p.displayName) ?? `User ${counter++}`);
            }
        }
    }

    // 从文本中自动提取 "[timestamp] DisplayName: ..." 形式的发言者名
    const senderPattern = /^(?:\[.*?\]\s*)?([^:：\n]{1,30})[：:]\s/gm;
    let match: RegExpExecArray | null;
    while ((match = senderPattern.exec(text)) !== null) {
        const name = match[1].trim();
        if (name && !nameMap.has(name) && name.length > 0 && name.length <= 30) {
            nameMap.set(name, `User ${counter++}`);
        }
    }

    // 2. 按名字长度降序替换（避免短名误匹配长名的子串）
    const sortedNames = Array.from(nameMap.entries())
        .sort((a, b) => b[0].length - a[0].length);

    for (const [realName, anonName] of sortedNames) {
        // 转义正则特殊字符
        const escaped = realName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(escaped, "g"), anonName);
    }

    // 3. 去除 @mention（@user、@User_1 等形式）
    text = text.replace(/@[\w\u4e00-\u9fff]+/g, "");

    // 4. 去除时间戳
    // 匹配 [2024-01-01 12:00:00] 或 [12:00] 或 (2024/1/1 12:00) 之类的
    text = text.replace(/\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]/g, "");
    text = text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "");
    // 行首 timestamp: "2024-01-01 12:00 " 或 "12:00 "
    text = text.replace(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*/gm, "");

    // 5. 清理多余空行
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    return text;
}

// ─── Provider: Google Gemini ───

async function callGoogleGrounding(
    config: GroundingConfig,
    promptText: string,
): Promise<string | undefined> {
    const model = config.model || "gemini-2.0-flash-lite";

    const ai = new GoogleGenAI({ apiKey: config.apiKey });

    const startTime = performance.now();
    const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        config: {
            tools: [{ googleSearch: {} }],
        },
    });
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

    // Guardrail: 检查是否真的使用了 Google Search
    const metadata = response.candidates?.[0]?.groundingMetadata;
    const hasWebResults = metadata && (
        (metadata.webSearchQueries?.length ?? 0) > 0 ||
        ((metadata.groundingChunks ?? []) as any[]).filter((c: any) => c.web).length > 0
    );

    if (!hasWebResults) {
        log.info("Google Grounding 未返回搜索结果，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    const text = response.text ?? "";
    if (!text) {
        log.info("Google Grounding 返回空文本，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    // 构建引用列表
    const sources: string[] = [];
    const chunks = (metadata.groundingChunks ?? []) as any[];
    for (const chunk of chunks) {
        if (chunk.web?.uri) {
            sources.push(`- ${chunk.web.title ?? chunk.web.uri}: ${chunk.web.uri}`);
        }
    }

    const usage = response.usageMetadata;
    log.info("Google Grounding 完成", {
        elapsed: `${elapsed}s`,
        model,
        sources: sources.length,
        tokens: usage ? `${usage.promptTokenCount}→${usage.candidatesTokenCount}` : "N/A",
    });

    // 返回结构化文本
    let result = text;
    if (sources.length > 0) {
        result += "\n\n### 来源\n" + sources.join("\n");
    }
    return result;
}

// ─── Provider: Grok xAI ───

async function callGrokGrounding(
    config: GroundingConfig,
    promptText: string,
): Promise<string | undefined> {
    const baseUrl = (config.baseUrl || "https://api.x.ai/v1").replace(/\/$/, "");
    const model = config.model || "grok-3-mini-fast";

    const startTime = performance.now();
    const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model,
            input: [
                { role: "user", content: promptText },
            ],
            tools: [{ type: "web_search" }],
        }),
    });
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        log.warn("Grok Grounding API 错误", {
            status: response.status,
            body: body.slice(0, 300),
            elapsed: `${elapsed}s`,
        });
        return undefined;
    }

    const data = await response.json() as any;

    // 从 response.output 中提取 message 类型的 content
    const outputItems = Array.isArray(data.output) ? data.output : [];
    const messageItem = outputItems.find((item: any) => item.type === "message");
    const textContent = messageItem?.content
        ?.filter((c: any) => c.type === "output_text")
        ?.map((c: any) => c.text)
        ?.join("\n") ?? "";

    if (!textContent) {
        log.info("Grok Grounding 返回空文本，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    // Guardrail: 检查是否真的进行了网络搜索
    // Grok 在 output 中会有 type: "web_search_call" 的条目
    const hasWebSearch = outputItems.some((item: any) => item.type === "web_search_call");

    if (!hasWebSearch) {
        log.info("Grok Grounding 未执行网络搜索，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    // 提取搜索引用
    const sources: string[] = [];
    // Grok 把 citations 放在 messageItem.content 的 annotations 或顶级
    const annotations = messageItem?.content
        ?.flatMap((c: any) => c.annotations ?? [])
        ?.filter((a: any) => a.type === "url_citation") ?? [];
    for (const ann of annotations) {
        if (ann.url) {
            sources.push(`- ${ann.title ?? ann.url}: ${ann.url}`);
        }
    }

    log.info("Grok Grounding 完成", {
        elapsed: `${elapsed}s`,
        model,
        sources: sources.length,
        tokens: data.usage
            ? `${data.usage.input_tokens ?? "?"}→${data.usage.output_tokens ?? "?"}`
            : "N/A",
    });

    let result = textContent;
    if (sources.length > 0) {
        result += "\n\n### 来源\n" + sources.join("\n");
    }
    return result;
}

// ─── 对外接口 ───

/**
 * 执行并行 Grounding 联网搜索
 *
 * @param config Grounding 配置（provider + apiKey + baseUrl）
 * @param messagesText 经过 enrichMessages 富化后的消息文本
 * @param activePersons 活跃人物列表（用于隐私脱敏映射）
 * @returns 联网查证结果文本，如果没有有效结果则返回 undefined
 */
export async function runParallelGrounding(
    config: GroundingConfig,
    messagesText: string,
    activePersons?: Array<{ displayName: string; userId?: string; username?: string }>,
): Promise<string | undefined> {
    if (!config.apiKey) {
        log.debug("Grounding 未配置 API Key，跳过");
        return undefined;
    }

    // 1. 隐私脱敏
    const sanitizedText = sanitizeForGrounding(messagesText, activePersons);
    if (!sanitizedText || sanitizedText.length < 10) {
        log.debug("Grounding 脱敏后文本过短，跳过");
        return undefined;
    }

    // 2. 渲染 prompt
    const promptText = renderPrompt("GROUNDING", { sanitizedText });

    // 3. 根据 provider 分发
    try {
        if (config.provider === "google") {
            return await callGoogleGrounding(config, promptText);
        } else if (config.provider === "grok") {
            return await callGrokGrounding(config, promptText);
        } else {
            log.warn("未知 Grounding provider", { provider: config.provider });
            return undefined;
        }
    } catch (err) {
        log.warn("Grounding 执行失败", {
            provider: config.provider,
            error: String(err).slice(0, 300),
        });
        return undefined;
    }
}
