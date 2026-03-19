/**
 * modules/tavily.ts — Tavily 网络搜索模块
 *
 * 在 worker 进程内直接通过 @tavily/core SDK 发起网络请求。
 * 类似 docs.ts 的本地执行模式，不走 Host IPC。
 *
 * API key 从 process.env.TAVILY_API_KEY 读取。
 */

import { tavily } from "@tavily/core";

const apiKey = process.env.TAVILY_API_KEY ?? "";

function getClient() {
    if (!apiKey) {
        throw new Error(
            "[web] Tavily API key 未配置。请在 config.yaml 中设置 tavily_api_key。"
        );
    }
    return tavily({ apiKey });
}

export const web = {
    /**
     * 搜索网页内容
     * @param query - 搜索关键词
     * @param opts - 可选参数
     */
    search: async (
        query: string,
        opts?: {
            searchDepth?: "basic" | "advanced";
            topic?: "general" | "news" | "finance";
            maxResults?: number;
            includeAnswer?: boolean;
            includeRawContent?: false | "text" | "markdown";
            includeDomains?: string[];
            excludeDomains?: string[];
            timeRange?: "day" | "week" | "month" | "year";
        },
    ) => {
        const client = getClient();
        return client.search(query, {
            searchDepth: opts?.searchDepth ?? "basic",
            topic: opts?.topic ?? "general",
            maxResults: opts?.maxResults ?? 5,
            includeAnswer: opts?.includeAnswer ?? true,
            includeRawContent: opts?.includeRawContent,
            includeDomains: opts?.includeDomains ?? [],
            excludeDomains: opts?.excludeDomains ?? [],
            ...(opts?.timeRange ? { timeRange: opts.timeRange } : {}),
        });
    },

    /**
     * 从指定 URL 提取内容
     * @param urls - 要提取的 URL 列表
     * @param opts - 可选参数
     */
    extract: async (
        urls: string[],
        opts?: {
            extractDepth?: "basic" | "advanced";
            includeImages?: boolean;
        },
    ) => {
        const client = getClient();
        return client.extract(urls, {
            extractDepth: opts?.extractDepth ?? "basic",
            includeImages: opts?.includeImages ?? false,
        });
    },
};
