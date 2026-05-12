<script>
  import { onMount } from "svelte";
  import { activeTab } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import LlmProfilesTab from "./config/LlmProfilesTab.svelte";
  import LlmRoutingTab from "./config/LlmRoutingTab.svelte";
  import PersonaTab from "./config/PersonaTab.svelte";
  import TimezoneTab from "./config/TimezoneTab.svelte";
  import TelegramTab from "./config/TelegramTab.svelte";
  import DiscordTab from "./config/DiscordTab.svelte";
  import OneBotTab from "./config/OneBotTab.svelte";
  import ReflectionTab from "./config/ReflectionTab.svelte";
  import ContextBudgetTab from "./config/ContextBudgetTab.svelte";
  import EmbeddingTab from "./config/EmbeddingTab.svelte";
  import VisionTab from "./config/VisionTab.svelte";
  import DashboardTab from "./config/DashboardTab.svelte";
  import SubagentTab from "./config/SubagentTab.svelte";
  import RecordingPipelineTab from "./config/RecordingPipelineTab.svelte";
  import EnvVarsTab from "./config/EnvVarsTab.svelte";
  import SystemPromptsTab from "./config/SystemPromptsTab.svelte";
  import GroundingTab from "./config/GroundingTab.svelte";
  import RateLimitingTab from "./config/RateLimitingTab.svelte";

  let config = null;
  let originalConfig = null;
  let loading = true;
  let saving = false;
  let toast = null;
  let toastTimer = null;
  let telegramEnabled = false;
  let discordEnabled = false;
  let onebotEnabled = false;

  /** Password 输入框：focus 显示明文，blur 恢复隐藏 */
  function pwFocus(e) { e.target.type = 'text'; }
  function pwBlur(e) { e.target.type = 'password'; }
  let currentSection = "llmProfiles";

  let profileTests = {};
  let showNewProfile = false;
  let newProfileName = "";
  let newKeyword = "";
  let newBaseSkill = "";
  /** 当前展开的 profile 名称集合 */
  let expandedProfiles = new Set();

  const SECTIONS = [
    { id: "llmProfiles", label: "LLM Profiles", icon: "fa-microchip" },
    { id: "llmRouting", label: "组件路由", icon: "fa-route" },
    { id: "persona", label: "人格 & 唤醒", icon: "fa-user-astronaut" },
    { id: "timezone", label: "时区", icon: "fa-clock" },
    { id: "telegram", label: "Telegram", icon: "fa-paper-plane" },
    { id: "discord", label: "Discord", icon: "fa-gamepad" },
    { id: "onebot", label: "QQ / OneBot", icon: "fa-comments" },
    { id: "reflection", label: "反思引擎", icon: "fa-brain" },
    { id: "contextBudget", label: "上下文预算", icon: "fa-sliders" },
    { id: "embedding", label: "Embedding", icon: "fa-vector-square" },
    { id: "vision", label: "Vision", icon: "fa-eye" },
    { id: "dashboard", label: "Dashboard", icon: "fa-gauge-high" },
    { id: "subagent", label: "CodeAct", icon: "fa-robot" },
    { id: "recordingPipeline", label: "Recording", icon: "fa-tape" },
    { id: "systemPrompts", label: "System Prompts", icon: "fa-file-lines" },
    { id: "grounding", label: "Grounding", icon: "fa-globe" },
    { id: "rateLimiting", label: "请求限速", icon: "fa-gauge-high" },
    { id: "envVars", label: "环境变量", icon: "fa-key" },
  ];

  const RESTART_SECTIONS = new Set(["embedding", "dashboard"]);
  const RESTART_FIELDS = {
    telegram: ["mode", "botToken", "apiId", "apiHash", "phone"],
    discord: ["botToken"],
    onebot: ["wsUrl", "selfId", "sendFileAsDataUrl"],
    subagent: ["maxSandboxInstances"],
  };

  const ROUTING_COMPONENTS = [
    { key: "meta", label: "Meta-CodeAct", desc: "跨群编排与任务分派" },
    { key: "session", label: "CodeAct 交互", desc: "生成回复内容" },
    { key: "recording_cluster", label: "话题聚类", desc: "消息→话题分组" },
    { key: "recording_triage", label: "话题 Triage", desc: "摘要 + 介入判断" },
    { key: "reflection", label: "反思引擎", desc: "人物画像/总结" },
    { key: "compact", label: "上下文压缩", desc: "对话历史摘要" },
    { key: "memory", label: "记忆检索", desc: "Deep recall" },
    { key: "vision", label: "视觉描述", desc: "图片/贴纸描述" },
  ];

  $: if ($activeTab === "config" && !config) loadConfigData();

  // Reactive snapshot of routing — forces {#key} re-render when routing changes
  $: routingSnapshot = config ? JSON.stringify(config.llmRouting) : "";

  async function loadConfigData() {
    loading = true;
    try {
      config = await api("/config");
      if (!config.contextBudget) config.contextBudget = {};
      if (!config.vision) config.vision = {};
      if (config.vision.stickerStealingEnabled == null) config.vision.stickerStealingEnabled = true;
      if (!config.dashboard) config.dashboard = {};
      if (config.dashboard.host == null || config.dashboard.host === "") {
        config.dashboard.host = "127.0.0.1";
      }
      if (!config.subagent) config.subagent = {};
      if (config.subagent.restrictAdapterWritesToBoundChat == null) {
        config.subagent.restrictAdapterWritesToBoundChat = false;
      }
      if (config.subagent.deduplicateSentMessages == null) {
        config.subagent.deduplicateSentMessages = true;
      }
      if (config.subagent.postTaskWindowMs == null) config.subagent.postTaskWindowMs = 120000;
      if (!config.subagent.metaHistory) config.subagent.metaHistory = {};
      if (!config.subagent.baseSkills) config.subagent.baseSkills = [
        "runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "vision", "shell",
      ];
      if (!config.llmRouting) config.llmRouting = {};
      if (!config.llmRouting.timeouts) config.llmRouting.timeouts = {};
      if (!config.recordingPipeline) config.recordingPipeline = {};
      if (!config.envVars) config.envVars = [];
      if (!config.grounding) config.grounding = { provider: 'google', apiKey: '' };
      if (!config.rateLimiting) config.rateLimiting = { enabled: false, maxConcurrency: 0, requestsPerMinute: 0, perProfile: {} };
      if (!config.rateLimiting.perProfile) config.rateLimiting.perProfile = {};
      // Adapter 启用状态：根据后端是否返回了有效配置来判断
      // bot 模式看 botToken，userbot 模式看 apiId + apiHash + phone
      telegramEnabled = !!(
        config.telegram?.botToken ||
        (config.telegram?.apiId && config.telegram?.apiHash && config.telegram?.phone)
      );
      discordEnabled = !!config.discord?.botToken;
      onebotEnabled = !!(config.onebot?.wsUrl && config.onebot?.selfId);
      // 始终确保 UI 有空对象可绑定
      if (!config.telegram) config.telegram = { mode: 'bot', botToken: '', apiId: '', apiHash: '', phone: '' };
      if (!config.telegram.whitelist) {
        config.telegram.whitelist = { enabled: false, groups: [], users: [] };
      }
      if (!config.discord) config.discord = { botToken: "", applicationId: "" };
      if (!config.onebot) config.onebot = { wsUrl: '', selfId: '', sendFileAsDataUrl: false };
      if (config.onebot.sendFileAsDataUrl == null) config.onebot.sendFileAsDataUrl = false;
      if (!config.onebot.whitelist) {
        config.onebot.whitelist = { enabled: false, groups: [], users: [] };
      }
      if (!config.onebot.humanizedDelay) {
        config.onebot.humanizedDelay = {
          enabled: false,
          msPerChar: 50,
          minDelay: 500,
          maxDelay: 5000,
        };
      }
      if (config.telegram && !config.telegram.humanizedDelay) {
        config.telegram.humanizedDelay = {
          enabled: false,
          msPerChar: 50,
          minDelay: 500,
          maxDelay: 5000,
        };
      }
      if (!config.reflection.mergeThresholds)
        config.reflection.mergeThresholds = {};
      if (!config.reflection.tierLimits) config.reflection.tierLimits = {};
      originalConfig = JSON.parse(JSON.stringify(config));
    } catch (err) {
      showToast("加载配置失败: " + err, "error");
    }
    loading = false;
  }

  function hasRestartChanges() {
    if (!originalConfig || !config) return false;
    for (const sec of RESTART_SECTIONS) {
      if (JSON.stringify(config[sec]) !== JSON.stringify(originalConfig[sec]))
        return true;
    }
    for (const [sec, fields] of Object.entries(RESTART_FIELDS)) {
      for (const f of fields) {
        if (config[sec]?.[f] !== originalConfig[sec]?.[f]) return true;
      }
    }
    if (JSON.stringify(config.envVars) !== JSON.stringify(originalConfig.envVars)) return true;
    if (
      JSON.stringify(config.telegram?.whitelist) !==
      JSON.stringify(originalConfig.telegram?.whitelist)
    )
      return true;
    if (
      JSON.stringify(config.onebot?.whitelist) !==
      JSON.stringify(originalConfig.onebot?.whitelist)
    )
      return true;
    return false;
  }

  async function saveAll() {
    saving = true;
    const needsRestart = hasRestartChanges();
    try {
      // 根据开关决定是否包含 adapter 配置
      const payload = JSON.parse(JSON.stringify(config));
      if (!telegramEnabled) delete payload.telegram;
      if (!discordEnabled) delete payload.discord;
      if (!onebotEnabled) delete payload.onebot;
      const res = await api("/config", { method: "PUT", body: payload });
      if (res.ok) {
        originalConfig = JSON.parse(JSON.stringify(config));
        if (needsRestart) {
          showToast(
            "✅ 配置已保存。部分修改需要重启服务才能生效，请点击底部「重启服务」按钮。",
            "warning",
          );
        } else {
          showToast("✅ 配置已保存并即时生效", "success");
        }
      } else {
        const errMsg = res.errors
          ? res.errors.join("\n")
          : res.error || "未知错误";
        showToast("❌ 验证失败:\n" + errMsg, "error");
      }
    } catch (err) {
      showToast("❌ 保存失败: " + err, "error");
    }
    saving = false;
  }

  async function testProfile(name) {
    const p = config.llmProfiles[name];
    if (!p) return;
    profileTests = { ...profileTests, [name]: { testing: true } };
    try {
      const res = await api("/config/test-profile", {
        method: "POST",
        body: p,
      });
      profileTests = { ...profileTests, [name]: res };
    } catch (err) {
      profileTests = {
        ...profileTests,
        [name]: { ok: false, error: String(err) },
      };
    }
  }

  async function restartService() {
    if (
      !confirm(
        "确定要重启服务吗？需要有进程管理器（pm2/systemd）才能自动恢复。",
      )
    )
      return;
    try {
      await api("/restart", { method: "POST" });
      showToast("🔄 服务正在重启...", "success");
    } catch {
      showToast("发送重启信号失败", "error");
    }
  }

  function showToast(msg, type = "info") {
    toast = { msg, type };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => {
        toast = null;
      },
      type === "error" ? 8000 : 5000,
    );
  }

  function addProfile() {
    if (!newProfileName.trim()) return;
    if (config.llmProfiles[newProfileName]) {
      showToast("名称已存在", "error");
      return;
    }
    config.llmProfiles[newProfileName] = {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "",
      temperature: 0.7,
      maxTokens: 8192,
    };
    config = config;
    newProfileName = "";
    showNewProfile = false;
  }
  function deleteProfile(name) {
    if (!confirm(`删除 Profile "${name}"？`)) return;
    delete config.llmProfiles[name];
    expandedProfiles.delete(name);
    config = config;
  }

  function cloneProfile(srcName) {
    const newName = prompt(`复制 "${srcName}" 为新 Profile，请输入名称：`);
    if (!newName || !newName.trim()) return;
    if (config.llmProfiles[newName]) {
      showToast(`名称 "${newName}" 已存在`, "error");
      return;
    }
    config.llmProfiles[newName] = JSON.parse(JSON.stringify(config.llmProfiles[srcName]));
    config = config;
    expandedProfiles.add(newName);
    expandedProfiles = expandedProfiles;
  }
  function addKeyword() {
    const kw = newKeyword.trim();
    if (!kw) return;
    if (!config.notification.mentionKeywords.includes(kw)) {
      config.notification.mentionKeywords = [
        ...config.notification.mentionKeywords,
        kw,
      ];
    }
    newKeyword = "";
  }
  function removeKeyword(kw) {
    config.notification.mentionKeywords =
      config.notification.mentionKeywords.filter((k) => k !== kw);
  }
  // ── Base Skills helpers ──
  function addBaseSkill() {
    const sk = newBaseSkill.trim();
    if (!sk) return;
    if (!config.subagent.baseSkills) config.subagent.baseSkills = [];
    if (!config.subagent.baseSkills.includes(sk)) {
      config.subagent.baseSkills = [...config.subagent.baseSkills, sk];
    }
    newBaseSkill = "";
  }
  function removeBaseSkill(sk) {
    config.subagent.baseSkills = config.subagent.baseSkills.filter((s) => s !== sk);
  }
  function resetBaseSkills() {
    config.subagent.baseSkills = [
      "runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "vision", "shell",
    ];
    config = config;
  }
  function getProfileNames() {
    return config ? Object.keys(config.llmProfiles) : [];
  }

  // ── Env Vars helpers ──
  function addEnvVar() {
    config.envVars = [...(config.envVars || []), { key: "", value: "", scope: "both" }];
  }
  function removeEnvVar(idx) {
    config.envVars = config.envVars.filter((_, i) => i !== idx);
  }

  function getRoutingValue(key) {
    const v = config.llmRouting[key];
    if (!v) return [];
    return Array.isArray(v) ? [...v] : [v];
  }
  function addRoutingProfile(compKey, profileName) {
    if (!profileName) return;
    const arr = getRoutingValue(compKey);
    if (!arr.includes(profileName)) {
      arr.push(profileName);
      config.llmRouting[compKey] = arr.length === 1 ? arr[0] : [...arr];
      config = config;
    }
  }
  function removeRoutingProfile(compKey, idx) {
    const arr = getRoutingValue(compKey);
    arr.splice(idx, 1);
    config.llmRouting[compKey] =
      arr.length === 0 ? undefined : arr.length === 1 ? arr[0] : [...arr];
    config = config;
  }

  // ── Drag and Drop state for routing profiles ──
  let draggedItem = null;
  let draggedCompKey = null;

  function handleRoutingDragStart(compKey, idx) {
    draggedItem = idx;
    draggedCompKey = compKey;
  }

  function handleRoutingDrop(compKey, dropIdx) {
    if (draggedCompKey !== compKey) return;
    if (draggedItem === null || draggedItem === dropIdx) {
      draggedItem = null;
      draggedCompKey = null;
      return;
    }
    const arr = getRoutingValue(compKey);
    const item = arr.splice(draggedItem, 1)[0];
    arr.splice(dropIdx, 0, item);
    config.llmRouting[compKey] = arr.length === 1 ? arr[0] : [...arr];
    config = config;
    draggedItem = null;
    draggedCompKey = null;
  }

  function handleRoutingDragEnd() {
    draggedItem = null;
    draggedCompKey = null;
  }

  // ── System Prompts state ──
  let promptList = [];
  let promptTree = {};
  let promptsLoading = false;
  let expandedDirs = new Set();
  let selectedPrompt = null;
  let promptOriginal = "";
  let promptOverride = "";
  let promptHasOverride = false;
  let promptEditorContent = "";
  let promptSaving = false;
  let promptDetailLoading = false;

  $: if (currentSection === "systemPrompts" && promptList.length === 0 && !promptsLoading) loadPromptList();

  function buildTree(files) {
    const tree = {};
    for (const f of files) {
      const parts = f.relativePath.split("/");
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = { __children: {} };
        node = node[parts[i]].__children;
      }
      node[parts[parts.length - 1]] = { __file: f };
    }
    return tree;
  }

  async function loadPromptList() {
    promptsLoading = true;
    try {
      const res = await api("/system-prompts");
      promptList = res.prompts || [];
      promptTree = buildTree(promptList);
      // auto-expand all dirs
      for (const f of promptList) {
        const parts = f.relativePath.split("/");
        for (let i = 0; i < parts.length - 1; i++) {
          expandedDirs.add(parts.slice(0, i + 1).join("/"));
        }
      }
      expandedDirs = expandedDirs;
    } catch (err) {
      showToast("加载 prompt 列表失败: " + err, "error");
    }
    promptsLoading = false;
  }

  async function selectPrompt(relativePath) {
    selectedPrompt = relativePath;
    promptDetailLoading = true;
    try {
      const res = await api("/system-prompts/" + relativePath);
      promptOriginal = res.original || "";
      promptOverride = res.override || "";
      promptHasOverride = res.hasOverride;
      promptEditorContent = promptHasOverride ? promptOverride : promptOriginal;
    } catch (err) {
      showToast("加载 prompt 详情失败: " + err, "error");
    }
    promptDetailLoading = false;
  }

  async function savePromptOverride() {
    if (!selectedPrompt) return;
    promptSaving = true;
    try {
      const res = await api("/system-prompts/" + selectedPrompt, {
        method: "PUT",
        body: { content: promptEditorContent },
      });
      if (res.ok) {
        promptHasOverride = true;
        promptOverride = promptEditorContent;
        // refresh list to update override status marker
        await loadPromptList();
        showToast("✅ Override 已保存并即时生效", "success");
      } else {
        showToast("❌ 保存失败: " + (res.error || "未知错误"), "error");
      }
    } catch (err) {
      showToast("❌ 保存失败: " + err, "error");
    }
    promptSaving = false;
  }

  async function deletePromptOverride() {
    if (!selectedPrompt) return;
    if (!confirm("确定删除此 override，恢复到原始版本？")) return;
    try {
      const res = await api("/system-prompts/" + selectedPrompt, {
        method: "DELETE",
      });
      if (res.ok) {
        promptHasOverride = false;
        promptOverride = "";
        promptEditorContent = promptOriginal;
        await loadPromptList();
        showToast("✅ Override 已删除，已恢复原始版本", "success");
      }
    } catch (err) {
      showToast("❌ 删除失败: " + err, "error");
    }
  }

  function resetPromptEditor() {
    promptEditorContent = promptOriginal;
  }
</script>

{#if loading || !config}
  <div class="flex justify-center items-center h-64">
    <span class="loading loading-spinner loading-lg"></span>
  </div>
{:else}
  <div class="flex gap-4 config-layout">
    <!-- Left Nav -->
    <div class="w-52 shrink-0 config-sidebar">
      <div class="card bg-base-100">
        <div class="card-body p-3">
          <h3 class="card-title text-sm mb-1">配置项</h3>
          <div class="space-y-0.5">
            {#each SECTIONS as sec}
              <button
                class="nav-item"
                class:active={currentSection === sec.id}
                on:click={() => (currentSection = sec.id)}
              >
                <i class="fa-solid {sec.icon} fa-fw"></i>
                <span>{sec.label}</span>
                {#if RESTART_SECTIONS.has(sec.id)}
                  <i
                    class="fa-solid fa-rotate-right nav-restart-icon"
                    title="此区段修改后需重启"
                  ></i>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>

    <!-- Right Editor -->
    <div class="flex-1 min-w-0">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          {#if currentSection === "llmProfiles"}
            <LlmProfilesTab
              bind:config
              bind:profileTests
              bind:expandedProfiles
              bind:showNewProfile
              bind:newProfileName
              {testProfile}
              {cloneProfile}
              {deleteProfile}
              {pwFocus}
              {pwBlur}
              {addProfile}
            />
          {:else if currentSection === "llmRouting"}
            <LlmRoutingTab
              bind:config
              {ROUTING_COMPONENTS}
              {routingSnapshot}
              {getRoutingValue}
              {addRoutingProfile}
              {removeRoutingProfile}
              {getProfileNames}
              {handleRoutingDragStart}
              {handleRoutingDrop}
              {handleRoutingDragEnd}
              bind:draggedCompKey
              bind:draggedItem
            />
          {:else if currentSection === "persona"}
            <PersonaTab bind:config bind:newKeyword {addKeyword} {removeKeyword} />
          {:else if currentSection === "timezone"}
            <TimezoneTab bind:config />
          {:else if currentSection === "telegram"}
            <TelegramTab bind:config bind:telegramEnabled {pwFocus} {pwBlur} />
          {:else if currentSection === "discord"}
            <DiscordTab bind:config bind:discordEnabled {pwFocus} {pwBlur} />
          {:else if currentSection === "onebot"}
            <OneBotTab bind:config bind:onebotEnabled />
          {:else if currentSection === "reflection"}
            <ReflectionTab bind:config />
          {:else if currentSection === "contextBudget"}
            <ContextBudgetTab bind:config />
          {:else if currentSection === "embedding"}
            <EmbeddingTab bind:config {pwFocus} {pwBlur} />
          {:else if currentSection === "vision"}
            <VisionTab bind:config />
          {:else if currentSection === "dashboard"}
            <DashboardTab bind:config {pwFocus} {pwBlur} />
          {:else if currentSection === "subagent"}
            <SubagentTab
              bind:config
              bind:newBaseSkill
              {addBaseSkill}
              {removeBaseSkill}
              {resetBaseSkills}
            />
          {:else if currentSection === "recordingPipeline"}
            <RecordingPipelineTab bind:config />
          {:else if currentSection === "envVars"}
            <EnvVarsTab bind:config {pwFocus} {pwBlur} {addEnvVar} {removeEnvVar} />
          {:else if currentSection === "rateLimiting"}
            <RateLimitingTab bind:config profileNames={Object.keys(config.llmProfiles ?? {})} />
          {:else if currentSection === "grounding"}
            <GroundingTab bind:config {pwFocus} {pwBlur} />
          {:else if currentSection === "systemPrompts"}
            <SystemPromptsTab
              bind:promptsLoading
              bind:promptTree
              bind:expandedDirs
              bind:selectedPrompt
              bind:promptDetailLoading
              bind:promptHasOverride
              bind:promptEditorContent
              bind:promptSaving
              bind:promptOriginal
              {selectPrompt}
              {savePromptOverride}
              {resetPromptEditor}
              {deletePromptOverride}
            />
          {/if}
        </div>
      </div>

      <!-- Bottom Action Bar -->
      <div class="config-action-bar">
        <button
          class="btn btn-primary btn-sm"
          on:click={saveAll}
          disabled={saving}
        >
          <i class="fa-solid fa-floppy-disk"></i>
          {saving ? "保存中..." : "保存配置"}
        </button>
        <button
          class="btn btn-ghost btn-sm"
          on:click={() => {
            config = null;
            loadConfigData();
          }}
        >
          <i class="fa-solid fa-arrow-rotate-left"></i> 重置
        </button>
        <div class="flex-1"></div>
        <button
          class="btn btn-error btn-sm btn-outline"
          on:click={restartService}
        >
          <i class="fa-solid fa-rotate-right"></i> 重启服务
        </button>
      </div>
    </div>
  </div>

  {#if toast}
    <div class="toast toast-top toast-center z-50">
      <div
        class="alert py-2 px-4 shadow-lg"
        class:alert-success={toast.type === "success"}
        class:alert-error={toast.type === "error"}
        class:alert-warning={toast.type === "warning"}
        class:alert-info={toast.type === "info"}
      >
        <span class="text-sm whitespace-pre-wrap">{toast.msg}</span>
      </div>
    </div>
  {/if}
{/if}

<style>
  /* ── Nav ── */
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
    background: none;
    border: none;
    color: inherit;
    width: 100%;
    opacity: 0.7;
  }
  .nav-item:hover {
    opacity: 1;
    background: var(--color-base-200);
  }
  .nav-item.active {
    opacity: 1;
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
  }
  .nav-restart-icon {
    margin-left: auto;
    font-size: 0.55rem;
    color: var(--color-warning);
    opacity: 0.6;
  }

  /* ── Grid systems ── */
  :global(.cfg-grid-2) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  :global(.cfg-grid-3) {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  :global(.cfg-field) {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  :global(.cfg-label) {
    font-size: 0.7rem;
    opacity: 0.6;
    padding-left: 1px;
  }
  :global(.cfg-check) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.25rem 0;
  }

  /* ── Profile card ── */
  :global(.profile-card) {
    border-left: 3px solid var(--color-primary);
    padding: 0.75rem;
    border-radius: 0.25rem;
    background: var(--color-base-200);
    margin-bottom: 0.5rem;
  }

  /* ── Routing row ── */
  :global(.routing-row) {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: var(--color-base-200);
  }

  /* ── Restart indicators ── */
  :global(.restart-hint) {
    font-size: 0.6rem;
    font-weight: 400;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
    margin-left: 0.5rem;
    vertical-align: middle;
  }
  :global(.restart-icon) {
    font-size: 0.55rem;
    color: var(--color-warning);
    opacity: 0.6;
    margin-right: 0.2rem;
  }

  /* ── Action bar ── */
  .config-action-bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.75rem 1rem;
    margin-top: 0.5rem;
    background: var(--color-base-100);
    border: 1px solid
      color-mix(in srgb, var(--color-base-content) 10%, transparent);
    border-radius: 0.5rem;
  }

  /* col-span utilities for grid */
  :global(.col-span-2) {
    grid-column: span 2;
  }
  :global(.col-span-3) {
    grid-column: span 3;
  }

  /* ── Mobile ── */
  @media (max-width: 768px) {
    .config-layout {
      flex-direction: column !important;
      gap: 0.5rem;
    }
    .config-sidebar {
      width: 100% !important;
      flex-shrink: 0;
    }
    .config-sidebar .card-body {
      padding: 0.4rem !important;
    }
    .config-sidebar .card-title {
      display: none;
    }
    .config-sidebar .space-y-0\.5 {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
    .nav-item {
      white-space: nowrap;
      padding: 0.3rem 0.5rem;
      font-size: 0.7rem;
    }
    .nav-item i.fa-fw {
      display: none;
    }
    .nav-restart-icon {
      display: none;
    }
    .config-action-bar {
      flex-wrap: wrap;
    }
    :global(.profile-card .cfg-grid-2) {
      grid-template-columns: 1fr !important;
    }
    .prompt-editor-layout {
      flex-direction: column;
    }
    .prompt-tree-panel {
      width: 100% !important;
      max-height: 200px;
    }
  }

  /* ── Prompt Editor ── */
  :global(.prompt-editor-layout) {
    min-height: 300px;
  }
  :global(.prompt-tree-panel) {
    width: 220px;
    flex-shrink: 0;
    max-height: 600px;
    overflow-y: auto;
    border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
    border-radius: 0.5rem;
    padding: 0.5rem;
  }
  :global(.prompt-dir) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.4rem;
    border-radius: 0.25rem;
    cursor: pointer;
    user-select: none;
  }
  :global(.prompt-dir:hover) {
    background: var(--color-base-200);
  }
  :global(.prompt-file) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.4rem 0.25rem 1.6rem;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: background 0.1s;
  }
  :global(.prompt-file:hover) {
    background: var(--color-base-200);
  }
  :global(.prompt-file.active) {
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
  }
  :global(.prompt-textarea) {
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    line-height: 1.5;
    tab-size: 2;
    resize: vertical;
  }
</style>
