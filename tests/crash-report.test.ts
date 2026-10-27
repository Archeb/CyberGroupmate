import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCrashReport } from "../src/core/crash-report.js";

// node:test 按文件起独立进程，process.chdir 只影响本文件

describe("writeCrashReport", () => {
    it("writes a structured JSON report under workspace/crash-reports", () => {
        const previousCwd = process.cwd();
        const tmpRoot = mkdtempSync(join(tmpdir(), "cgm-crash-report-"));
        try {
            process.chdir(tmpRoot);
            writeCrashReport("unhandledRejection", new Error("kaboom"));

            const dir = join(tmpRoot, "workspace", "crash-reports");
            const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
            assert.equal(files.length, 1);
            const report = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
            assert.equal(report.kind, "unhandledRejection");
            assert.match(report.message, /kaboom/);
            assert.match(report.stack ?? "", /kaboom/);
            assert.ok(report.timestamp);
            assert.ok(report.pid);
        } finally {
            process.chdir(previousCwd);
            rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it("does not throw when the payload is not an Error", () => {
        const previousCwd = process.cwd();
        const tmpRoot = mkdtempSync(join(tmpdir(), "cgm-crash-report-"));
        try {
            process.chdir(tmpRoot);
            assert.doesNotThrow(() => writeCrashReport("uncaughtException", "plain string reason"));
            const dir = join(tmpRoot, "workspace", "crash-reports");
            const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
            assert.equal(files.length, 1);
        } finally {
            process.chdir(previousCwd);
            rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
