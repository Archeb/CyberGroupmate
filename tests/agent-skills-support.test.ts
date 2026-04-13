import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { docs, getAgentSkillScriptDirs, getAgentSkillsApiBriefs, getAgentSkillsBriefs } from "../src/sandbox/modules/docs.js";
import { loadApiTypeDefs } from "../src/subagent/code-act-executor.js";
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
    it("discovers SKILL.md metadata and strips frontmatter when reading", () => {
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

        const list = docs.list();
        const item = list.find(doc => doc.slug === "my-cool-bot");

        assert.ok(item, "应发现标准 Agent Skill");
        assert.equal(item?.kind, "agent-skill");
        assert.ok(item?.title.includes("[AgentSkill] my-cool-bot"));

        const content = docs.read("my-cool-bot");
        assert.ok(content.includes("# My Cool Bot"));
        assert.ok(content.includes("run-bot.sh"));
        assert.ok(!content.includes("name: my-cool-bot"), "返回内容应去掉 frontmatter");
    });

    it("generates LLM briefs and exposes skill script directories", () => {
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

        const briefs = getAgentSkillsBriefs();
        assert.ok(briefs.includes('- kube-deploy: Deploy to Kubernetes.'));
        assert.ok(briefs.includes('docs.read("kube-deploy")'));

        const apiBriefs = getAgentSkillsApiBriefs();
        assert.ok(apiBriefs.includes('## agent-skills'));
        assert.ok(apiBriefs.includes('- kube-deploy: Deploy to Kubernetes.'));
        assert.ok(apiBriefs.includes('docs.read("kube-deploy")'));

        const scriptDirs = getAgentSkillScriptDirs(process.cwd());
        assert.ok(scriptDirs.includes(resolve(scriptsDir)));

        const enhancedPath = buildEnhancedShellPath(process.cwd(), "/usr/bin");
        assert.ok(enhancedPath.includes(resolve(scriptsDir)));
        assert.ok(enhancedPath.includes("/usr/bin"));
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

        const api = loadApiTypeDefs("telegram");
        assert.ok(api.includes("## agent-skills"));
        assert.ok(api.includes("x-search: Search X (Twitter) posts using the xAI API."));
        assert.ok(api.includes('docs.read("x-search")'));
    });
});
