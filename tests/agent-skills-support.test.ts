import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { discoverSkills, getAgentSkillScriptDirs, loadAllSkills, parseAllSkillDocs } from "../src/sandbox/skill-loader.js";
import { loadApiTypeDefs, refreshModuleRegistryCache } from "../src/subagent/code-act-executor.js";
import { buildEnhancedShellPath } from "../src/sandbox/sandbox.js";

const createdPaths = new Set<string>();

function ensureDir(path: string): void {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
        createdPaths.add(path);
    }
}

function writeFile(path: string, content: string): void {
    ensureDir(dirname(path));
    writeFileSync(path, content, "utf-8");
    createdPaths.add(path);
}

after(() => {
    const sorted = [...createdPaths].sort((a, b) => b.length - a.length);
    for (const entry of sorted) {
        rmSync(entry, { recursive: true, force: true });
    }
});

describe("Agent Skills native support", () => {
    it("discovers SKILL.md metadata as AgentSkill module entries", () => {
        const skillDir = join(process.cwd(), "workspace", "skills", "test-std-skill");
        const skillMdPath = join(skillDir, "SKILL.md");
        const scriptsDir = join(skillDir, "scripts");

        ensureDir(scriptsDir);
        writeFile(skillMdPath, [
            "---",
            "name: my-cool-bot",
            "description: Extract PDF text.",
            "---",
            "",
            "# My Cool Bot",
            "",
            "Use `run-bot.sh` to execute the workflow.",
            "",
        ].join("\n"));
        writeFile(join(scriptsDir, "run-bot.sh"), "#!/bin/bash\necho Hello API\n");

        const modules = parseAllSkillDocs();
        const item = modules.find(mod => mod.name === "my_cool_bot");

        assert.ok(item, "应发现标准 Agent Skill");
        assert.equal(item?.description, "Extract PDF text.");
        assert.equal(item?.methods.length, 1);
        assert.ok(item?.methods[0].brief.includes("await my_cool_bot.use()"));
    });

    it("exposes skill script directories and injects AgentSkill API brief", () => {
        const skillDir = join(process.cwd(), "workspace", "skills", "test-std-skill-brief");
        const skillMdPath = join(skillDir, "SKILL.md");
        const scriptsDir = join(skillDir, "scripts");

        ensureDir(scriptsDir);
        writeFile(skillMdPath, [
            "---",
            "name: kube-deploy",
            "description: Deploy to Kubernetes.",
            "---",
            "",
            "Run the deploy script when instructed.",
            "",
        ].join("\n"));
        writeFile(join(scriptsDir, "deploy.sh"), "#!/bin/bash\necho deploy\n");

        const scriptDirs = getAgentSkillScriptDirs(process.cwd());
        assert.ok(scriptDirs.includes(resolve(scriptsDir)));

        const enhancedPath = buildEnhancedShellPath(process.cwd(), "/usr/bin");
        assert.ok(enhancedPath.includes(resolve(scriptsDir)));
        assert.ok(enhancedPath.includes("/usr/bin"));

        refreshModuleRegistryCache();
        const api = loadApiTypeDefs("telegram");
        assert.ok(api.includes("## kube_deploy"));
        assert.ok(api.includes("Deploy to Kubernetes."));
        assert.ok(api.includes("await kube_deploy.use()"));
    });

    it("includes standard Agent Skills in available API overview", () => {
        const skillDir = join(process.cwd(), "workspace", "skills", "x-search");
        const skillMdPath = join(skillDir, "SKILL.md");
        const scriptsDir = join(skillDir, "scripts");

        ensureDir(scriptsDir);
        writeFile(skillMdPath, [
            "---",
            "name: x-search",
            "description: Search X (Twitter) posts using the xAI API.",
            "---",
            "",
            "# X Search",
            "",
            "Use python3 {baseDir}/scripts/search.py to search X.",
            "",
        ].join("\n"));
        writeFile(join(scriptsDir, "search.py"), "print('ok')\n");

        refreshModuleRegistryCache();
        const api = loadApiTypeDefs("telegram");
        assert.ok(api.includes("## x_search"));
        assert.ok(api.includes("Search X (Twitter) posts using the xAI API."));
        assert.ok(api.includes("await x_search.use()"));
    });

    it("uses SKILL.md as roster fallback for code-backed skills without d.ts", async () => {
        const skillDir = join(process.cwd(), "workspace", "skills", "gptImage2");
        const skillMdPath = join(skillDir, "SKILL.md");
        const indexPath = join(skillDir, "index.ts");

        ensureDir(skillDir);
        writeFile(skillMdPath, [
            "---",
            "name: gptImage2",
            "description: Generate images with GPT Image.",
            "---",
            "",
            "# GPT Image 2",
            "",
            "Call the exported image helpers after reading this guide.",
            "",
        ].join("\n"));
        writeFile(indexPath, [
            "export default {",
            "  generate: async () => 'ok'",
            "};",
            "",
        ].join("\n"));

        assert.ok(discoverSkills().some(skill => skill.name === "gptImage2" && skill.skillMdPath));

        const modules = parseAllSkillDocs();
        const item = modules.find(mod => mod.name === "gptImage2");
        assert.ok(item, "应使用 SKILL.md fallback 暴露代码型 Skill");
        assert.equal(item?.description, "Generate images with GPT Image.");
        assert.ok(item?.methods[0].brief.includes("await gptImage2.use()"));

        refreshModuleRegistryCache();
        const api = loadApiTypeDefs("telegram", new Set(["gptImage2"]));
        assert.ok(api.includes("## gptImage2"));
        assert.ok(api.includes("Generate images with GPT Image."));

        const loaded = await loadAllSkills();
        const runtimeSkill = loaded.find(skill => skill.name === "gptImage2");
        assert.equal(typeof runtimeSkill?.exports.use, "function");
        assert.equal(await (runtimeSkill?.exports.generate as () => Promise<string>)(), "ok");
    });
});
