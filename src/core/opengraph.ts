/**
 * opengraph.ts — URL OpenGraph 元数据抓取
 *
 * 使用 open-graph-scraper 库抓取 URL 的 OpenGraph 元信息（标题、描述、封面图等）。
 * 带内存 LRU 缓存，避免重复抓取。
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import ogs from "open-graph-scraper";
import { createLogger } from "./logger.js";

const log = createLogger("opengraph");

// ─── 类型定义 ───

export interface OGResult {
    url: string;
    title?: string;
    description?: string;
    siteName?: string;
    /** OG 封面图 URL */
    imageUrl?: string;
}

// ─── URL 提取 ───

/** 从文本中提取 HTTP/HTTPS URL 列表（去重） */
export function extractUrls(text: string): string[] {
    // 匹配 http(s):// 开头的 URL，不包含末尾标点/括号
    const urlRegex = /https?:\/\/[^\s<>"'`\])》）]+/gi;
    const matches = text.match(urlRegex);
    if (!matches) return [];
    // 去除末尾常见标点
    const cleaned = matches.map(u => u.replace(/[.,;:!?。，；：！？]+$/, ""));
    return [...new Set(cleaned)];
}

// ─── LRU 缓存 ───

interface CacheEntry {
    result: OGResult | null;
    timestamp: number;
}

const CACHE_MAX_SIZE = 200;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const cache = new Map<string, CacheEntry>();

function getCached(url: string): OGResult | null | undefined {
    const entry = cache.get(url);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        cache.delete(url);
        return undefined;
    }
    return entry.result;
}

function setCache(url: string, result: OGResult | null): void {
    // LRU eviction: 超过上限时删掉最早的条目
    if (cache.size >= CACHE_MAX_SIZE) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
    }
    cache.set(url, { result, timestamp: Date.now() });
}

// ─── 核心抓取函数 ───

/**
 * 抓取 URL 的 OpenGraph 元数据
 *
 * @param url 目标 URL
 * @param timeoutSeconds 超时秒数（默认 5）
 * @returns OGResult 或 null（失败时）
 */
export async function fetchOpenGraph(url: string, timeoutSeconds = 5): Promise<OGResult | null> {
    // 检查缓存
    const cached = getCached(url);
    if (cached !== undefined) {
        log.debug("OG 缓存命中", { url });
        return cached;
    }

    try {
        const { error, result } = await ogs({ url, timeout: timeoutSeconds });

        if (error) {
            log.debug("OG 抓取失败", { url, error: true });
            setCache(url, null);
            return null;
        }

        const ogResult: OGResult = {
            url,
            title: result.ogTitle,
            description: result.ogDescription,
            siteName: result.ogSiteName,
            imageUrl: result.ogImage?.[0]?.url,
        };

        // 如果什么有用信息都没抓到，视为无效
        if (!ogResult.title && !ogResult.description && !ogResult.imageUrl) {
            log.debug("OG 无有效元数据", { url });
            setCache(url, null);
            return null;
        }

        log.debug("OG 抓取成功", {
            url,
            title: ogResult.title?.slice(0, 50),
            hasImage: !!ogResult.imageUrl,
        });

        setCache(url, ogResult);
        return ogResult;
    } catch (err) {
        log.debug("OG 抓取异常", { url, error: String(err).slice(0, 200) });
        setCache(url, null);
        return null;
    }
}

/**
 * 批量抓取多个 URL 的 OG 元数据（并行，去重）
 */
export async function fetchOpenGraphBatch(urls: string[]): Promise<Map<string, OGResult>> {
    const unique = [...new Set(urls)];
    const results = new Map<string, OGResult>();

    const tasks = unique.map(async (url) => {
        const result = await fetchOpenGraph(url);
        if (result) results.set(url, result);
    });

    await Promise.allSettled(tasks);
    return results;
}

// ─── 封面图下载 ───

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;

// og:image 来自被抓取的网页，可以指向任意地址，下载前拒绝内网/回环/元数据地址
const blockedRanges = new BlockList();
for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blockedRanges.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
    ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedRanges.addSubnet(net, prefix, "ipv6");

function isBlockedAddress(address: string): boolean {
    const family = isIP(address);
    return family === 0 || blockedRanges.check(address, family === 6 ? "ipv6" : "ipv4");
}

async function isPublicHttpUrl(url: URL): Promise<boolean> {
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return !isBlockedAddress(host);
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && !addresses.some(a => isBlockedAddress(a.address));
}

/**
 * 下载 OG 封面图片为 Buffer
 *
 * 每一跳（含重定向）都检查目标是否为公网地址，超过 5MB 时中途停止读取。
 *
 * @param imageUrl 图片 URL
 * @param timeoutMs 超时毫秒（默认 8000）
 * @returns { buffer, mimeType } 或 null
 */
export async function downloadOgImage(
    imageUrl: string,
    timeoutMs = 8000,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
        const signal = AbortSignal.timeout(timeoutMs);
        let url = new URL(imageUrl);
        let response: Response | undefined;
        for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
            if (!(await isPublicHttpUrl(url))) {
                log.debug("OG 图片地址不是公网地址", { imageUrl, url: url.href });
                return null;
            }
            response = await fetch(url, {
                signal,
                redirect: "manual",
                headers: {
                    "User-Agent": "Mozilla/5.0 (compatible; CyberGroupmate/1.0)",
                },
            });
            const location = response.headers.get("location");
            if (response.status < 300 || response.status >= 400 || !location) break;
            await response.body?.cancel();
            url = new URL(location, url);
            response = undefined;
        }

        if (!response?.ok) {
            log.debug("OG 图片下载失败", { imageUrl, status: response?.status });
            return null;
        }

        const contentType = response.headers.get("content-type") ?? "image/jpeg";
        // 确保是图片
        if (!contentType.startsWith("image/")) {
            log.debug("OG 图片非图片类型", { imageUrl, contentType });
            await response.body?.cancel();
            return null;
        }

        // 大小限制: 5MB，边读边计数，不先把整个响应读进内存
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body ?? []) {
            size += chunk.byteLength;
            if (size > MAX_IMAGE_BYTES) {
                log.debug("OG 图片过大", { imageUrl, size });
                return null; // 跳出 for await 会取消剩余的响应流
            }
            chunks.push(chunk);
        }

        const mimeType = contentType.split(";")[0].trim();
        return { buffer: Buffer.concat(chunks), mimeType };
    } catch (err) {
        log.debug("OG 图片下载异常", { imageUrl, error: String(err).slice(0, 200) });
        return null;
    }
}
