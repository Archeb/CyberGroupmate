/**
 * perceptual-hash.ts — 感知哈希 (pHash + dHash 双哈希)
 *
 * pHash (DCT-based): 对格式转换、压缩、缩放更鲁棒，适合跨平台场景
 * dHash (Difference Hash): 对缩放/压缩鲁棒，与 pHash 互补
 *
 * 使用 sharp 库实现，安装失败时回退到纯 SHA256 模式。
 */

import { createLogger } from "./logger.js";

const log = createLogger("phash");

let sharpAvailable = false;
let sharpInstance: any = null;

try {
    // @ts-expect-error sharp is an optional native dependency
    const mod = await import("sharp");
    sharpInstance = mod.default;
    sharpAvailable = true;
    log.info("sharp 库已加载，pHash + dHash 功能可用");
} catch {
    log.info("sharp 库不可用，pHash + dHash 功能禁用（仅使用 SHA256 精确匹配）");
}

export function isPerceptualHashAvailable(): boolean {
    return sharpAvailable;
}

export interface PerceptualHashResult {
    phash: string | null;
    dhash: string | null;
}

export async function computePerceptualHashes(buffer: Buffer): Promise<PerceptualHashResult> {
    if (!sharpAvailable || !sharpInstance) return { phash: null, dhash: null };

    try {
        const phash = await computePHash(buffer);
        const dhash = await computeDHash(buffer);
        return { phash, dhash };
    } catch (err) {
        log.debug("computePerceptualHashes: 计算失败", { error: String(err) });
        return { phash: null, dhash: null };
    }
}

async function computeDHash(buffer: Buffer): Promise<string | null> {
    try {
        const { data, info } = await sharpInstance(buffer)
            .grayscale()
            .resize(9, 8, { fit: "fill" })
            .raw()
            .toBuffer({ resolveWithObject: true });

        if (info.width !== 9 || info.height !== 8) return null;

        let hash = 0n;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const left = data[row * 9 + col];
                const right = data[row * 9 + col + 1];
                if (left > right) hash |= 1n;
                hash <<= 1n;
            }
        }

        return hash.toString(16).padStart(16, "0");
    } catch (err) {
        log.debug("computeDHash: 计算失败", { error: String(err) });
        return null;
    }
}

async function computePHash(buffer: Buffer): Promise<string | null> {
    try {
        const { data, info } = await sharpInstance(buffer)
            .grayscale()
            .resize(32, 32, { fit: "fill" })
            .raw()
            .toBuffer({ resolveWithObject: true });

        if (info.width !== 32 || info.height !== 32) return null;

        const pixels = new Float64Array(32 * 32);
        for (let i = 0; i < 32 * 32; i++) {
            pixels[i] = data[i];
        }

        const dct = dct2d(pixels, 32, 32);

        const lowFreq: number[] = [];
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if (row === 0 && col === 0) continue;
                lowFreq.push(dct[row * 32 + col]);
            }
        }

        const median = medianValue(lowFreq);

        let hash = 0n;
        for (const val of lowFreq) {
            hash <<= 1n;
            if (val > median) hash |= 1n;
        }

        return hash.toString(16).padStart(16, "0");
    } catch (err) {
        log.debug("computePHash: 计算失败", { error: String(err) });
        return null;
    }
}

function dct2d(input: Float64Array, rows: number, cols: number): Float64Array {
    const output = new Float64Array(rows * cols);

    const temp = new Float64Array(rows * cols);
    for (let i = 0; i < rows; i++) {
        for (let k = 0; k < cols; k++) {
            let sum = 0;
            for (let n = 0; n < cols; n++) {
                sum += input[i * cols + n] * Math.cos(Math.PI * (2 * n + 1) * k / (2 * cols));
            }
            const c = k === 0 ? Math.sqrt(1 / cols) : Math.sqrt(2 / cols);
            temp[i * cols + k] = sum * c;
        }
    }

    for (let k = 0; k < rows; k++) {
        for (let j = 0; j < cols; j++) {
            let sum = 0;
            for (let n = 0; n < rows; n++) {
                sum += temp[n * cols + j] * Math.cos(Math.PI * (2 * n + 1) * k / (2 * rows));
            }
            const c = k === 0 ? Math.sqrt(1 / rows) : Math.sqrt(2 / rows);
            output[k * cols + j] = sum * c;
        }
    }

    return output;
}

function medianValue(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function hammingDistance(hash1: string, hash2: string): number {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) return Infinity;
    const big1 = BigInt("0x" + hash1);
    const big2 = BigInt("0x" + hash2);
    let xor = big1 ^ big2;
    let dist = 0;
    while (xor !== 0n) {
        dist += Number(xor & 1n);
        xor >>= 1n;
    }
    return dist;
}

export interface SimilarityResult {
    entry: import("./image-catalog.js").ImageCatalogEntry;
    phashDistance?: number;
    dhashDistance?: number;
    minDistance: number;
}

export function findSimilarEntries(
    allEntries: import("./image-catalog.js").ImageCatalogEntry[],
    phash: string | null,
    dhash: string | null,
    maxPHashDistance: number = 14,
    maxDHashDistance: number = 10,
): SimilarityResult[] {
    const results: SimilarityResult[] = [];

    for (const entry of allEntries) {
        let phashDist: number | undefined;
        let dhashDist: number | undefined;
        let matched = false;

        if (phash && entry.phash) {
            phashDist = hammingDistance(phash, entry.phash);
            if (phashDist <= maxPHashDistance) matched = true;
        }

        if (dhash && entry.dhash) {
            dhashDist = hammingDistance(dhash, entry.dhash);
            if (dhashDist <= maxDHashDistance) matched = true;
        }

        if (matched) {
            const minDist = Math.min(
                phashDist ?? Infinity,
                dhashDist ?? Infinity,
            );
            results.push({ entry, phashDistance: phashDist, dhashDistance: dhashDist, minDistance: minDist });
        }
    }

    results.sort((a, b) => a.minDistance - b.minDistance);
    return results;
}
