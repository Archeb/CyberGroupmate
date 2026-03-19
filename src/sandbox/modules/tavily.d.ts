/**
 * tavily.d.ts — 网络搜索模块类型定义
 *
 * Agent 可通过 web 对象进行实时联网搜索和网页内容提取。
 * 底层使用 Tavily Search API。
 */

/** 搜索结果中的单条条目 */
interface WebSearchResult {
    /** 页面标题 */
    title: string;
    /** 页面 URL */
    url: string;
    /** 页面内容摘要 */
    content: string;
    /** 相关度评分 (0-1) */
    score: number;
    /** 原始页面内容（需 includeRawContent: true） */
    rawContent?: string;
}

/** 搜索响应 */
interface WebSearchResponse {
    /** 搜索结果列表 */
    results: WebSearchResult[];
    /** 原始查询 */
    query: string;
    /** 响应耗时（秒） */
    responseTime: number;
    /** AI 生成的直接答案（需 includeAnswer: true） */
    answer?: string;
    /** 图片结果 */
    images?: Array<{ url: string; description?: string }>;
}

/** 提取成功的结果 */
interface WebExtractResult {
    /** 源 URL */
    url: string;
    /** 提取的页面内容 */
    raw_content: string;
}

/** 提取失败的结果 */
interface WebExtractFailedResult {
    /** 源 URL */
    url: string;
    /** 错误信息 */
    error: string;
}

/** 提取响应 */
interface WebExtractResponse {
    /** 成功提取的结果 */
    results: WebExtractResult[];
    /** 提取失败的结果 */
    failed_results: WebExtractFailedResult[];
    /** 响应耗时（秒） */
    response_time: number;
}

/** 系统注入的网络搜索模块。 */
declare const web: {
    /**
     * 搜索网页内容。
     * 返回相关网页的标题、URL 和内容摘要。
     *
     * @example
     * const result = await web.search("2024年奥运会金牌榜");
     * console.log(result.answer);         // AI 生成的直接答案
     * console.log(result.results[0].url); // 第一个搜索结果的 URL
     *
     * @example 高级搜索（更深层抓取，结果更准确但更慢）
     * const result = await web.search("React vs Vue 对比", {
     *   searchDepth: "advanced",
     *   maxResults: 10,
     * });
     */
    search(
        query: string,
        opts?: {
            /** 搜索深度。"basic" 更快，"advanced" 更深入准确。默认 "basic" */
            searchDepth?: "basic" | "advanced";
            /** 搜索主题。默认 "general" */
            topic?: "general" | "news" | "finance";
            /** 最大结果数 (1-20)。默认 5 */
            maxResults?: number;
            /** 是否返回 AI 生成的直接答案。默认 true */
            includeAnswer?: boolean;
            /** 是否返回原始页面内容。默认 false */
            includeRawContent?: boolean;
            /** 限定搜索域名 */
            includeDomains?: string[];
            /** 排除搜索域名 */
            excludeDomains?: string[];
            /** 时间范围过滤 */
            timeRange?: "day" | "week" | "month" | "year";
        },
    ): Promise<WebSearchResponse>;

    /**
     * 从指定 URL 提取页面内容。
     *
     * @example
     * const result = await web.extract(["https://example.com/article"]);
     * console.log(result.results[0].raw_content);
     */
    extract(
        urls: string[],
        opts?: {
            /** 提取深度。"basic" 更快，"advanced" 更深入。默认 "basic" */
            extractDepth?: "basic" | "advanced";
            /** 是否提取图片。默认 false */
            includeImages?: boolean;
        },
    ): Promise<WebExtractResponse>;
};
