/**
 * tests/memory-embedding.test.ts — 存储层 embedding 特性：backfill / setFactEmbedding / 维度变更重建
 *
 * 全程离线：用 provider="local"（hash-based localEmbed）算向量，不联网。
 * 维度变更断言依赖 sqlite-vec（vec0）；不可用时自动跳过该部分（CI/容器内有 vec 时全跑）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStoreV2 } from "../src/memory-v2/memory-v2.js";
import { localEmbed } from "../src/memory-v2/embedding.js";
import type { EmbeddingConfig } from "../src/core/config.js";

const DIR = "/tmp/cybergroupmate-test";

function embCfg(dimensions: number): EmbeddingConfig {
    return { enabled: true, provider: "local", baseUrl: "", apiKey: "", model: "local", dimensions, similarityMetric: "cosine" };
}
function freshStore(name: string, embeddingConfig?: EmbeddingConfig): { store: MemoryStoreV2; path: string } {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const path = join(DIR, `${name}.db`);
    for (const s of ["", "-wal", "-shm"]) { if (existsSync(path + s)) unlinkSync(path + s); }
    return { store: new MemoryStoreV2(path, embeddingConfig ? { embeddingConfig } : undefined), path };
}
function rm(path: string): void {
    for (const s of ["", "-wal", "-shm"]) { try { if (existsSync(path + s)) unlinkSync(path + s); } catch { /* ignore */ } }
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = (s: MemoryStoreV2): any => (s as unknown as { db: any }).db;
const factEmbedding = (s: MemoryStoreV2, id: string): unknown =>
    raw(s).prepare("SELECT embedding FROM core_facts WHERE id = ?").get(id)?.embedding ?? null;
const vecSql = (s: MemoryStoreV2, name: string): string =>
    (raw(s).prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql as string | undefined) ?? "";

describe("memory embedding — backfill + setFactEmbedding（离线 local provider）", () => {
    it("无 embeddingConfig 时 backfillEmbeddings 返回 0（不嵌入）", async () => {
        const { store, path } = freshStore("memb-off");
        try {
            store.storeFact("u1", "alice 喜欢拉面", "preference");
            assert.deepEqual(await store.backfillEmbeddings(), { facts: 0, topics: 0 });
        } finally { store.close(); rm(path); }
    });

    it("backfillEmbeddings 给存量无向量的 fact/topic 补 embedding 列（且幂等）", async () => {
        const { store, path } = freshStore("memb-backfill", embCfg(64));
        try {
            store.storeFact("u1", "alice 喜欢拉面", "preference");   // 入库时不带向量
            store.storeFact("u2", "bob 爱爬山", "preference");
            store.upsertTopic("t1", {
                chatId: "-100", label: "京都旅行", summary: "岚山竹林和交通",
                keywords: ["京都"], participants: ["u1"], startedAt: new Date().toISOString(), sentiment: "positive",
            });
            const r = await store.backfillEmbeddings();
            assert.equal(r.facts, 2, "2 条 fact 补向量");
            assert.ok(r.topics >= 1, "至少 1 条 topic 补向量");
            const db = raw(store);
            assert.equal(db.prepare("SELECT count(*) c FROM core_facts WHERE embedding IS NOT NULL").get().c, 2);
            assert.ok(db.prepare("SELECT count(*) c FROM topics WHERE embedding IS NOT NULL").get().c >= 1);
            assert.deepEqual(await store.backfillEmbeddings(), { facts: 0, topics: 0 }, "已嵌入的不再重复处理");
        } finally { store.close(); rm(path); }
    });

    it("setFactEmbedding 给已存在 fact 写入向量列", () => {
        const { store, path } = freshStore("memb-set", embCfg(64));
        try {
            const id = store.storeFact("u1", "alice 住东京", "other");
            assert.equal(factEmbedding(store, id), null, "初始无向量");
            store.setFactEmbedding(id, localEmbed("alice 住东京", 64));
            assert.notEqual(factEmbedding(store, id), null, "setFactEmbedding 后有向量");
        } finally { store.close(); rm(path); }
    });
});

describe("memory embedding — 维度变更检测 + 重建 vec0（需 sqlite-vec）", () => {
    it("更换 dimensions → DROP+按新维度重建 vec 表并清空旧向量（提示重跑 backfill）", () => {
        const { store: s1, path } = freshStore("memb-dimchange", embCfg(64));
        const hasVec = s1.sqliteVecAvailable;
        let factId = "";
        try {
            factId = s1.storeFact("u1", "alice 喜欢拉面", "preference", undefined, undefined, localEmbed("alice 喜欢拉面", 64));
            assert.notEqual(factEmbedding(s1, factId), null);
            if (hasVec) assert.match(vecSql(s1, "facts_vec"), /float\[64\]/, "初始 vec 表为 64 维");
        } finally { s1.close(); }

        if (!hasVec) { rm(path); return; } // sqlite-vec 不可用：维度由 vec0 表承载，跳过

        const s2 = new MemoryStoreV2(path, { embeddingConfig: embCfg(128) });
        try {
            assert.match(vecSql(s2, "facts_vec"), /float\[128\]/, "vec 表已按新维度 128 重建");
            assert.equal(factEmbedding(s2, factId), null, "旧维度向量已清空");
        } finally { s2.close(); rm(path); }
    });

    it("关闭 embedding（无 embeddingConfig）时不动已有 vec 表（不误删向量）", () => {
        const { store: s1, path } = freshStore("memb-toggleoff", embCfg(64));
        const hasVec = s1.sqliteVecAvailable;
        let factId = "";
        try {
            factId = s1.storeFact("u1", "x 内容", "other", undefined, undefined, localEmbed("x 内容", 64));
        } finally { s1.close(); }
        if (!hasVec) { rm(path); return; }

        const s2 = new MemoryStoreV2(path); // embedding off
        try {
            assert.match(vecSql(s2, "facts_vec"), /float\[64\]/, "关闭 embedding 时保留原 64 维表");
            assert.notEqual(factEmbedding(s2, factId), null, "向量未被清空");
        } finally { s2.close(); rm(path); }
    });
});
