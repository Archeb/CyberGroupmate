<script>
  import { onMount } from "svelte";
  import { activeTab } from "../lib/stores.js";
  import { api } from "../lib/api.js";

  let config = null;
  let originalConfig = null;
  let loading = true;
  let saving = false;
  let toast = null;
  let toastTimer = null;
  let telegramEnabled = false;
  let discordEnabled = false;

  /** Password 输入框：focus 显示明文，blur 恢复隐藏 */
  function pwFocus(e) { e.target.type = 'text'; }
  function pwBlur(e) { e.target.type = 'password'; }
  let currentSection = "llmProfiles";

  let profileTests = {};
  let showNewProfile = false;
  let newProfileName = "";
  let newKeyword = "";
  /** 当前展开的 profile 名称集合 */
  let expandedProfiles = new Set();

  const SECTIONS = [
    { id: "llmProfiles", label: "LLM Profiles", icon: "fa-microchip" },
    { id: "llmRouting", label: "组件路由", icon: "fa-route" },
    { id: "persona", label: "人格 & 唤醒", icon: "fa-user-astronaut" },
    { id: "timezone", label: "时区", icon: "fa-clock" },
    { id: "telegram", label: "Telegram", icon: "fa-paper-plane" },
    { id: "discord", label: "Discord", icon: "fa-gamepad" },
    { id: "reflection", label: "反思引擎", icon: "fa-brain" },
    { id: "contextBudget", label: "上下文预算", icon: "fa-sliders" },
    { id: "embedding", label: "Embedding", icon: "fa-vector-square" },
    { id: "vision", label: "Vision", icon: "fa-eye" },
    { id: "dashboard", label: "Dashboard", icon: "fa-gauge-high" },
    { id: "subagent", label: "Subagent", icon: "fa-robot" },
    { id: "recordingPipeline", label: "Recording", icon: "fa-tape" },
    { id: "systemPrompts", label: "System Prompts", icon: "fa-file-lines" },
    { id: "envVars", label: "环境变量", icon: "fa-key" },
  ];

  const RESTART_SECTIONS = new Set(["embedding", "dashboard"]);
  const RESTART_FIELDS = {
    telegram: ["mode", "botToken", "apiId", "apiHash", "phone"],
    discord: ["botToken"],
    subagent: ["maxSandboxInstances"],
  };

  const ROUTING_COMPONENTS = [
    { key: "attend", label: "注意力决策", desc: "判断是否需要回复" },
    { key: "session", label: "CodeAct 交互", desc: "生成回复内容" },
    { key: "fast_path", label: "快速回复", desc: "轻量级即时回复" },
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
      if (!config.dashboard) config.dashboard = {};
      if (config.dashboard.host == null || config.dashboard.host === "") {
        config.dashboard.host = "127.0.0.1";
      }
      if (!config.subagent) config.subagent = {};
      if (!config.llmRouting) config.llmRouting = {};
      if (!config.llmRouting.timeouts) config.llmRouting.timeouts = {};
      if (!config.recordingPipeline) config.recordingPipeline = {};
      if (!config.envVars) config.envVars = [];
      // Adapter 启用状态：根据后端是否返回了有效配置来判断
      // bot 模式看 botToken，userbot 模式看 apiId + apiHash + phone
      telegramEnabled = !!(
        config.telegram?.botToken ||
        (config.telegram?.apiId && config.telegram?.apiHash && config.telegram?.phone)
      );
      discordEnabled = !!config.discord?.botToken;
      // 始终确保 UI 有空对象可绑定
      if (!config.telegram) config.telegram = { mode: 'bot', botToken: '', apiId: '', apiHash: '', phone: '' };
      if (!config.telegram.whitelist) {
        config.telegram.whitelist = { enabled: false, groups: [], users: [] };
      }
      if (!config.discord) config.discord = { botToken: "", applicationId: "" };
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
          <!-- ══ LLM Profiles ══ -->
          {#if currentSection === "llmProfiles"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-microchip opacity-50 mr-1"></i> LLM Profiles
            </h3>
            <p class="text-xs opacity-50 mb-3">
              定义命名 LLM 配置（provider / key / model），在组件路由中引用。
            </p>
            {#each Object.entries(config.llmProfiles) as [name, p]}
              <div class="profile-card">
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <div
                  class="flex justify-between items-center cursor-pointer select-none"
                  on:click={() => { expandedProfiles.has(name) ? expandedProfiles.delete(name) : expandedProfiles.add(name); expandedProfiles = expandedProfiles; }}
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <i class="fa-solid fa-chevron-right text-xs opacity-40 transition-transform" style:transform={expandedProfiles.has(name) ? "rotate(90deg)" : ""}></i>
                    <h4 class="font-mono font-bold text-sm truncate">{name}</h4>
                    <span class="text-xs opacity-40 truncate hidden sm:inline">
                      {p.provider}{p.model ? ` · ${p.model}` : ""}{p.baseUrl ? ` · ${p.baseUrl.replace(/^https?:\/\//, "").slice(0, 30)}` : ""}
                    </span>
                  </div>
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <div class="flex gap-1 flex-shrink-0" on:click|stopPropagation>
                    <button
                      class="btn btn-xs btn-outline btn-info"
                      on:click={() => testProfile(name)}
                      disabled={profileTests[name]?.testing}
                      title="测试连通性"
                    >
                      <i class="fa-solid fa-plug"></i>
                      {profileTests[name]?.testing ? "..." : "测试"}
                    </button>
                    <button
                      class="btn btn-xs btn-outline"
                      on:click={() => cloneProfile(name)}
                      title="复制 Profile"
                    >
                      <i class="fa-solid fa-copy"></i>
                    </button>
                    <button
                      class="btn btn-xs btn-outline btn-error"
                      on:click={() => deleteProfile(name)}
                      title="删除"
                    >
                      <i class="fa-solid fa-trash-can"></i>
                    </button>
                  </div>
                </div>
                {#if profileTests[name] && !profileTests[name].testing}
                  <div
                    class="alert alert-sm mb-2 mt-2 py-1"
                    class:alert-success={profileTests[name].ok}
                    class:alert-error={!profileTests[name].ok}
                  >
                    <span class="text-xs">
                      {profileTests[name].ok
                        ? `✅ ${profileTests[name].latency}ms · model: ${profileTests[name].model || "?"}`
                        : `❌ ${profileTests[name].error || `HTTP ${profileTests[name].status}`}`}
                    </span>
                  </div>
                {/if}
                {#if expandedProfiles.has(name)}
                <div class="mt-3">
                <div class="cfg-grid-2">
                  <label class="cfg-field"
                    ><span class="cfg-label">Provider</span>
                    <select
                      class="select select-xs select-bordered w-full"
                      bind:value={p.provider}
                    >
                      <option value="openai">openai (兼容)</option><option
                        value="anthropic">anthropic</option
                      ><option value="google">google (Gemini)</option>
                    </select></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Model</span>
                    <input
                      type="text"
                      class="input input-xs input-bordered w-full"
                      bind:value={p.model}
                      placeholder="gpt-4o"
                    /></label
                  >
                  <label class="cfg-field col-span-2"
                    ><span class="cfg-label">Base URL</span>
                    <input
                      type="text"
                      class="input input-xs input-bordered w-full"
                      bind:value={p.baseUrl}
                      placeholder="https://api.openai.com/v1"
                    /></label
                  >
                  <label class="cfg-field col-span-2"
                    ><span class="cfg-label">API Key</span>
                    <input
                      type="password"
                      class="input input-xs input-bordered w-full"
                      bind:value={p.apiKey}
                      on:focus={pwFocus}
                      on:blur={pwBlur}
                    /></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Temperature</span>
                    <input
                      type="number"
                      class="input input-xs input-bordered w-full"
                      bind:value={p.temperature}
                      min="0"
                      max="2"
                      step="0.1"
                    /></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Max Tokens</span>
                    <input
                      type="number"
                      class="input input-xs input-bordered w-full"
                      bind:value={p.maxTokens}
                      min="1"
                    /></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Max Context Tokens</span>
                    <input
                      type="number"
                      class="input input-xs input-bordered w-full"
                      bind:value={p.maxContextTokens}
                      placeholder="(默认)"
                    /></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Thinking Level</span>
                    <select
                      class="select select-xs select-bordered w-full"
                      bind:value={p.thinkingLevel}
                    >
                      <option value={undefined}>无</option><option value="none"
                        >none</option
                      ><option value="low">low</option><option value="medium"
                        >medium</option
                      ><option value="high">high</option>
                    </select></label
                  >
                  <label class="cfg-check"
                    ><input
                      type="checkbox"
                      class="checkbox checkbox-xs"
                      bind:checked={p.vision}
                    /><span>Vision</span></label
                  >
                  <label class="cfg-check"
                    ><input
                      type="checkbox"
                      class="checkbox checkbox-xs"
                      checked={p.supportsPrefill !== false}
                      on:change={(e) => {
                        p.supportsPrefill = e.target.checked
                          ? undefined
                          : false;
                        config = config;
                      }}
                    /><span>Prefill</span></label
                  >
                </div>
                {#if p.provider === "google"}
                  <div class="divider text-xs opacity-50 my-2">
                    <i class="fa-brands fa-google mr-1"></i>Vertex AI 设置（可选）
                  </div>
                  <p class="text-xs opacity-40 mb-2">
                    粘贴服务账号 JSON 密钥后自动启用 Vertex AI 模式。留空则使用 AI Studio（需填 API Key）。
                  </p>
                  <label class="cfg-field"
                    ><span class="cfg-label">服务账号 JSON 密钥</span>
                    <textarea
                      class="textarea textarea-bordered w-full font-mono text-xs"
                      rows="4"
                      placeholder='粘贴 Google 服务账号 JSON 密钥原文...'
                      value={p.vertexCredentials ? JSON.stringify(p.vertexCredentials, null, 2) : ""}
                      on:blur={(e) => {
                        const val = e.target.value.trim();
                        if (!val) {
                          p.vertexCredentials = undefined;
                        } else {
                          try {
                            p.vertexCredentials = JSON.parse(val);
                          } catch {
                            // 保持原值不变，用户可继续编辑
                          }
                        }
                        config = config;
                      }}
                    ></textarea>
                  </label>
                  <div class="cfg-grid-2 mt-1">
                    <label class="cfg-field"
                      ><span class="cfg-label">Project 覆盖 <span class="opacity-40">(可选)</span></span>
                      <input
                        type="text"
                        class="input input-xs input-bordered w-full"
                        bind:value={p.vertexProject}
                        placeholder={p.vertexCredentials?.project_id || "自动从 JSON 提取"}
                      /></label
                    >
                    <label class="cfg-field"
                      ><span class="cfg-label">Region</span>
                      <input
                        type="text"
                        class="input input-xs input-bordered w-full"
                        bind:value={p.vertexRegion}
                        placeholder="global"
                      /></label
                    >
                  </div>
                {/if}
                {#if p.provider === "openai" || p.provider === "anthropic"}
                  <div class="divider text-xs opacity-50 my-2">
                    <i class="fa-solid fa-plus-circle mr-1"></i>Extra Body（可选）
                  </div>
                  <p class="text-xs opacity-40 mb-2">
                    额外请求体字段，JSON 对象格式。会被展开合并到 API 请求中。例如：<code class="text-[10px]">&lbrace;"chat_template_kwargs":&lbrace;"enable_thinking":false&rbrace;&rbrace;</code>
                  </p>
                  <label class="cfg-field"
                    ><span class="cfg-label">Extra Body (JSON)</span>
                    <textarea
                      class="textarea textarea-bordered w-full font-mono text-xs"
                      rows="3"
                      placeholder={'{"key": "value"}'}
                      value={p.extraBody ? JSON.stringify(p.extraBody, null, 2) : ""}
                      on:blur={(e) => {
                        const val = e.target.value.trim();
                        if (!val) {
                          p.extraBody = undefined;
                          p._extraBodyError = undefined;
                        } else {
                          try {
                            const parsed = JSON.parse(val);
                            if (typeof parsed !== "object" || Array.isArray(parsed)) {
                              p._extraBodyError = "必须是 JSON 对象（不能是数组或基本类型）";
                            } else {
                              p.extraBody = parsed;
                              p._extraBodyError = undefined;
                            }
                          } catch (err) {
                            p._extraBodyError = "JSON 格式错误: " + err.message;
                          }
                        }
                        config = config;
                      }}
                    ></textarea>
                  </label>
                  {#if p._extraBodyError}
                    <div class="text-xs text-error mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>{p._extraBodyError}</div>
                  {/if}
                {/if}
                <!-- Pricing -->
                <div class="divider text-xs opacity-50 my-2">
                  <i class="fa-solid fa-coins mr-1"></i>Pricing（可选）
                </div>
                <p class="text-xs opacity-40 mb-2">
                  每百万 token 的价格（美元），用于 token 消耗统计。留空则不计费。
                </p>
                <div class="cfg-grid-2">
                  <label class="cfg-field"
                    ><span class="cfg-label">Input ($/M)</span>
                    <input
                      type="number"
                      class="input input-xs input-bordered w-full"
                      value={p.pricing?.input ?? ""}
                      on:input={(e) => {
                        if (!p.pricing) p.pricing = {};
                        p.pricing.input = e.target.value ? Number(e.target.value) : undefined;
                        config = config;
                      }}
                      placeholder="0"
                      min="0"
                      step="0.01"
                    /></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Output ($/M)</span>
                    <input
                      type="number"
                      class="input input-xs input-bordered w-full"
                      value={p.pricing?.output ?? ""}
                      on:input={(e) => {
                        if (!p.pricing) p.pricing = {};
                        p.pricing.output = e.target.value ? Number(e.target.value) : undefined;
                        config = config;
                      }}
                      placeholder="0"
                      min="0"
                      step="0.01"
                    /></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Cached Input ($/M)</span>
                    <input
                      type="number"
                      class="input input-xs input-bordered w-full"
                      value={p.pricing?.cachedInput ?? ""}
                      on:input={(e) => {
                        if (!p.pricing) p.pricing = {};
                        p.pricing.cachedInput = e.target.value ? Number(e.target.value) : undefined;
                        config = config;
                      }}
                      placeholder="(可选)"
                      min="0"
                      step="0.01"
                    /></label
                  >
                  <label class="cfg-field"
                    ><span class="cfg-label">Cache Creation ($/M)</span>
                    <input
                      type="number"
                      class="input input-xs input-bordered w-full"
                      value={p.pricing?.cacheCreation ?? ""}
                      on:input={(e) => {
                        if (!p.pricing) p.pricing = {};
                        p.pricing.cacheCreation = e.target.value ? Number(e.target.value) : undefined;
                        config = config;
                      }}
                      placeholder="(可选)"
                      min="0"
                      step="0.01"
                    /></label
                  >
                </div>
                </div>
                {/if}
              </div>
            {/each}
            <div class="flex items-center gap-2 mt-2">
              {#if showNewProfile}
                <input
                  type="text"
                  class="input input-sm input-bordered"
                  bind:value={newProfileName}
                  placeholder="名称"
                  on:keydown={(e) => e.key === "Enter" && addProfile()}
                />
                <button class="btn btn-sm btn-primary" on:click={addProfile}
                  >添加</button
                >
                <button
                  class="btn btn-sm btn-ghost"
                  on:click={() => (showNewProfile = false)}>取消</button
                >
              {:else}
                <button
                  class="btn btn-sm btn-outline btn-primary"
                  on:click={() => (showNewProfile = true)}
                >
                  <i class="fa-solid fa-plus"></i> 新建 Profile
                </button>
              {/if}
            </div>
          {/if}

          <!-- ══ LLM Routing ══ -->
          {#if currentSection === "llmRouting"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-route opacity-50 mr-1"></i> 组件级 LLM 路由
            </h3>
            <p class="text-xs opacity-50 mb-3">
              为每个组件分配 LLM profile。支持多个（fallback chain）。
            </p>
            {#key routingSnapshot}
              <div class="space-y-2">
                {#each ROUTING_COMPONENTS as comp}
                  {@const assigned = getRoutingValue(comp.key)}
                  <div class="routing-row">
                    <div class="routing-label">
                      <span class="font-mono text-xs font-bold">{comp.key}</span
                      >
                      <span class="text-xs opacity-40 ml-1">— {comp.desc}</span>
                    </div>
                    <div class="flex items-center gap-2 flex-wrap mt-1">
                      {#each assigned as pn, idx (pn)}
                        <div class="badge badge-primary badge-sm gap-1">
                          <span class="opacity-60 text-[10px]">#{idx + 1}</span>
                          {pn}
                          <button
                            class="btn btn-ghost btn-xs px-0 min-h-0 h-auto"
                            on:click={() => removeRoutingProfile(comp.key, idx)}
                          >
                            <i class="fa-solid fa-xmark text-[10px]"></i>
                          </button>
                        </div>
                      {/each}
                      {#if assigned.length === 0}
                        <span class="text-xs opacity-30 italic">未分配</span>
                      {/if}
                      <select
                        class="select select-xs select-bordered w-40"
                        on:change={(e) => {
                          addRoutingProfile(comp.key, e.target.value);
                          e.target.selectedIndex = 0;
                        }}
                      >
                        <option value="" disabled selected>+ 添加...</option>
                        {#each getProfileNames().filter((pn) => !assigned.includes(pn)) as pn}
                          <option value={pn}>{pn}</option>
                        {/each}
                      </select>
                      <label class="cfg-field" style="flex: 0 0 auto; min-width: 100px;">
                        <span class="cfg-label"><i class="fa-solid fa-stopwatch text-[9px] opacity-50 mr-0.5"></i>超时 (ms)</span>
                        <input
                          type="number"
                          class="input input-xs input-bordered w-full"
                          value={config.llmRouting.timeouts[comp.key] ?? ""}
                          on:input={(e) => {
                            const v = Number(e.target.value);
                            if (v > 0) {
                              config.llmRouting.timeouts[comp.key] = v;
                            } else {
                              delete config.llmRouting.timeouts[comp.key];
                            }
                            config = config;
                          }}
                          placeholder="60000"
                          min="1000"
                          step="1000"
                        />
                      </label>
                    </div>
                  </div>
                {/each}
              </div>
            {/key}
          {/if}

          <!-- ══ Persona & Notification (merged) ══ -->
          {#if currentSection === "persona"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-user-astronaut opacity-50 mr-1"></i> 人格 & 唤醒
            </h3>
            <p class="text-xs opacity-50 mb-3">
              Agent 的名字、人格描述以及唤醒关键词，注入到所有 LLM system
              prompt。
            </p>
            <div class="cfg-grid-2 mb-4">
              <label class="cfg-field col-span-2"
                ><span class="cfg-label">Agent 名字</span>
                <input
                  type="text"
                  class="input input-sm input-bordered w-full"
                  bind:value={config.persona.name}
                /></label
              >
            </div>
            <label class="cfg-field mb-4"
              ><span class="cfg-label">人格描述</span>
              <textarea
                class="textarea textarea-bordered w-full"
                rows="8"
                bind:value={config.persona.description}
              ></textarea></label
            >

            <div class="divider text-xs opacity-50 my-2">
              <i class="fa-solid fa-bell mr-1"></i>唤醒关键词
            </div>
            <p class="text-xs opacity-50 mb-2">
              消息包含这些关键词时立即触发处理（@提及 / 名字唤醒）。
            </p>
            <div class="flex flex-wrap gap-1 mb-2">
              {#each config.notification.mentionKeywords as kw}
                <div class="badge badge-outline badge-sm gap-1">
                  {kw}
                  <button
                    class="btn btn-ghost btn-xs px-0 min-h-0 h-auto"
                    on:click={() => removeKeyword(kw)}
                  >
                    <i class="fa-solid fa-xmark text-[10px]"></i>
                  </button>
                </div>
              {/each}
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                class="input input-sm input-bordered flex-1"
                bind:value={newKeyword}
                placeholder="输入关键词..."
                on:keydown={(e) => e.key === "Enter" && addKeyword()}
              />
              <button class="btn btn-sm btn-primary" on:click={addKeyword}
                ><i class="fa-solid fa-plus"></i></button
              >
            </div>
          {/if}

          <!-- ══ Timezone ══ -->
          {#if currentSection === "timezone"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-clock opacity-50 mr-1"></i> 全局时区
            </h3>
            <p class="text-xs opacity-50 mb-3">
              影响 prompt 中的时间显示和作息判断。使用 IANA 标识符。
            </p>
            <input
              type="text"
              class="input input-sm input-bordered w-full max-w-xs"
              bind:value={config.timezone}
              placeholder="Asia/Shanghai"
              list="tz-list"
            />
            <datalist id="tz-list">
              <option value="Asia/Shanghai"></option><option value="Asia/Tokyo"
              ></option><option value="America/New_York"></option>
              <option value="America/Los_Angeles"></option><option
                value="Europe/London"
              ></option><option value="UTC"></option>
            </datalist>
          {/if}

          <!-- ══ Telegram ══ -->
          {#if currentSection === "telegram"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-paper-plane opacity-50 mr-1"></i> Telegram 设置
            </h3>
            <label class="cfg-check mb-2">
              <input
                type="checkbox"
                class="toggle toggle-sm"
                bind:checked={telegramEnabled}
              />
              <span class="text-sm font-medium">启用 Telegram Adapter</span>
            </label>
            {#if !telegramEnabled}
              <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
            {/if}
            <div class:opacity-40={!telegramEnabled} class:pointer-events-none={!telegramEnabled}>
            <p class="text-xs opacity-50 mb-3">连接参数和发送行为。</p>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label"
                  ><i class="fa-solid fa-rotate-right restart-icon"></i> 连接模式</span
                >
                <select
                  class="select select-xs select-bordered w-full"
                  bind:value={config.telegram.mode}
                >
                  <option value="bot">bot</option><option value="userbot"
                    >userbot</option
                  >
                </select></label
              >
              <label class="cfg-field"
                ><span class="cfg-label"
                  ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot Token</span
                >
                <input
                  type="password"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.telegram.botToken}
                  on:focus={pwFocus}
                  on:blur={pwBlur}
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label"
                  ><i class="fa-solid fa-rotate-right restart-icon"></i> API ID</span
                >
                <input
                  type="text"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.telegram.apiId}
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label"
                  ><i class="fa-solid fa-rotate-right restart-icon"></i> API Hash</span
                >
                <input
                  type="password"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.telegram.apiHash}
                  on:focus={pwFocus}
                  on:blur={pwBlur}
                /></label
              >
              <label class="cfg-field col-span-2"
                ><span class="cfg-label"
                  ><i class="fa-solid fa-rotate-right restart-icon"></i> 手机号 (userbot)</span
                >
                <input
                  type="text"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.telegram.phone}
                  placeholder="+86..."
                /></label
              >
            </div>
            <div class="divider text-xs opacity-50 my-3">拟人化发送延迟</div>
            <label class="cfg-check mb-2">
              <input
                type="checkbox"
                class="toggle toggle-xs"
                bind:checked={config.telegram.humanizedDelay.enabled}
              />
              <span>启用拟人化延迟</span>
            </label>
            {#if config.telegram.humanizedDelay.enabled}
              <div class="cfg-grid-3">
                <label class="cfg-field"
                  ><span class="cfg-label">每字符 ms</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.telegram.humanizedDelay.msPerChar}
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">最小 ms</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.telegram.humanizedDelay.minDelay}
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">最大 ms</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.telegram.humanizedDelay.maxDelay}
                  /></label
                >
              </div>
            {/if}
            <div class="divider text-xs opacity-50 my-3">
              入站白名单 <span class="restart-hint"
                ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
              >
            </div>
            <p class="text-xs opacity-50 mb-2">
              启用后仅处理列表中的群组或私聊；私聊按对方用户 ID 匹配。
            </p>
            <label class="cfg-check mb-2">
              <input
                type="checkbox"
                class="toggle toggle-xs"
                bind:checked={config.telegram.whitelist.enabled}
              />
              <span>启用白名单</span>
            </label>
            <div class="cfg-grid-2">
              <label class="cfg-field col-span-2"
                ><span class="cfg-label">群组 ID（每行一个，如 -1001234567890）</span>
                <textarea
                  class="textarea textarea-bordered textarea-xs w-full font-mono min-h-[4rem]"
                  value={config.telegram.whitelist.groups.join("\n")}
                  on:input={(e) => {
                    config.telegram.whitelist.groups = e.target.value
                      .split(/\r?\n/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                  }}
                ></textarea></label
              >
              <label class="cfg-field col-span-2"
                ><span class="cfg-label">私聊用户 ID（每行一个）</span>
                <textarea
                  class="textarea textarea-bordered textarea-xs w-full font-mono min-h-[4rem]"
                  value={config.telegram.whitelist.users.join("\n")}
                  on:input={(e) => {
                    config.telegram.whitelist.users = e.target.value
                      .split(/\r?\n/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                  }}
                ></textarea></label
              >
            </div>
            </div>
          {/if}

          <!-- ══ Discord ══ -->
          {#if currentSection === "discord"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-gamepad opacity-50 mr-1"></i> Discord 设置
            </h3>
            <label class="cfg-check mb-2">
              <input
                type="checkbox"
                class="toggle toggle-sm"
                bind:checked={discordEnabled}
              />
              <span class="text-sm font-medium">启用 Discord Adapter</span>
            </label>
            {#if !discordEnabled}
              <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
            {/if}
            <div class:opacity-40={!discordEnabled} class:pointer-events-none={!discordEnabled}>
            <p class="text-xs opacity-50 mb-3">Bot 连接参数。修改后需重启服务。</p>
            <div class="cfg-grid-2">
              <label class="cfg-field col-span-2"
                ><span class="cfg-label"
                  ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot Token</span
                >
                <input
                  type="password"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.discord.botToken}
                  placeholder="Discord Bot Token"
                  on:focus={pwFocus}
                  on:blur={pwBlur}
                /></label
              >
              <label class="cfg-field col-span-2"
                ><span class="cfg-label">Application ID</span>
                <input
                  type="text"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.discord.applicationId}
                  placeholder="(可选)"
                /></label
              >
            </div>
            </div>
          {/if}

          <!-- ══ Reflection ══ -->
          {#if currentSection === "reflection"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-brain opacity-50 mr-1"></i> 反思引擎
            </h3>
            <p class="text-xs opacity-50 mb-3">
              反思引擎的触发条件、时间参数和渐进合并。
            </p>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label">冷场阈值 (秒)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.reflection.silenceThreshold}
                  placeholder="7200"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">最大间隔 (秒)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.reflection.maxInterval}
                  placeholder="86400"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">检查间隔 (秒)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.reflection.checkInterval}
                  placeholder="300"
                /></label
              >
            </div>
            <div class="divider text-xs opacity-50 my-3">渐进合并阈值 (天)</div>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label">Episode → Week</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.reflection.mergeThresholds.episodeToWeek}
                  placeholder="7"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">Week → Month</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.reflection.mergeThresholds.weekToMonth}
                  placeholder="30"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">Month → Quarter</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.reflection.mergeThresholds.monthToQuarter}
                  placeholder="90"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">Quarter → Year</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.reflection.mergeThresholds.quarterToYear}
                  placeholder="365"
                /></label
              >
            </div>
            <div class="divider text-xs opacity-50 my-3">作息时间</div>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label">起始小时</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  value={config.reflection.awakeHours?.[0] ?? ""}
                  on:input={(e) => {
                    if (!config.reflection.awakeHours)
                      config.reflection.awakeHours = [8, 24];
                    config.reflection.awakeHours[0] = Number(e.target.value);
                    config = config;
                  }}
                  placeholder="8"
                  min="0"
                  max="23"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">结束小时</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  value={config.reflection.awakeHours?.[1] ?? ""}
                  on:input={(e) => {
                    if (!config.reflection.awakeHours)
                      config.reflection.awakeHours = [8, 24];
                    config.reflection.awakeHours[1] = Number(e.target.value);
                    config = config;
                  }}
                  placeholder="24"
                  min="0"
                  max="24"
                /></label
              >
            </div>
          {/if}

          <!-- ══ Context Budget ══ -->
          {#if currentSection === "contextBudget"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-sliders opacity-50 mr-1"></i> Context Budget
            </h3>
            <p class="text-xs opacity-50 mb-3">
              上下文压缩的 token 预算分配。留空使用默认值。
            </p>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label">有效上下文窗口 (tokens)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.contextBudget.effectiveContextWindow}
                  placeholder="32000"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">OutputReserve (tokens)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.contextBudget.outputReserve}
                  placeholder="4096"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">System Prompt 比例</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.contextBudget.systemPromptRatio}
                  placeholder="0.20"
                  step="0.05"
                  min="0"
                  max="1"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">Briefing 比例</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.contextBudget.briefingRatio}
                  placeholder="0.15"
                  step="0.05"
                  min="0"
                  max="1"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">近期消息比例</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.contextBudget.recentHistoryRatio}
                  placeholder="0.50"
                  step="0.05"
                  min="0"
                  max="1"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">最少保留消息</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.contextBudget.minRecentMessages}
                  placeholder="6"
                /></label
              >
              <label class="cfg-field col-span-2"
                ><span class="cfg-label">Briefing 最大 tokens</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.contextBudget.maxBriefingTokens}
                  placeholder="3000"
                /></label
              >
            </div>
          {/if}

          <!-- ══ Embedding ══ -->
          {#if currentSection === "embedding"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-vector-square opacity-50 mr-1"></i>
              Embedding
              <span class="restart-hint"
                ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
              >
            </h3>
            <p class="text-xs opacity-50 mb-3">
              向量化提供者。切换后已有向量数据可能不兼容。
            </p>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label">Provider</span>
                <select
                  class="select select-xs select-bordered w-full"
                  bind:value={config.embedding.provider}
                >
                  <option value="local">local (本地 hash)</option><option
                    value="openai">openai (API)</option
                  >
                </select></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">相似度</span>
                <select
                  class="select select-xs select-bordered w-full"
                  bind:value={config.embedding.similarityMetric}
                >
                  <option value="cosine">cosine</option><option
                    value="dot_product">dot_product</option
                  >
                  <option value="euclidean">euclidean</option><option
                    value="manhattan">manhattan</option
                  >
                </select></label
              >
              {#if config.embedding.provider === "openai"}
                <label class="cfg-field col-span-2"
                  ><span class="cfg-label">Base URL</span>
                  <input
                    type="text"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.embedding.baseUrl}
                  /></label
                >
                <label class="cfg-field col-span-2"
                  ><span class="cfg-label">API Key</span>
                  <input
                    type="password"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.embedding.apiKey}
                    on:focus={pwFocus}
                    on:blur={pwBlur}
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">Model</span>
                  <input
                    type="text"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.embedding.model}
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">Dimensions</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.embedding.dimensions}
                  /></label
                >
              {/if}
            </div>
          {/if}

          <!-- ══ Vision ══ -->
          {#if currentSection === "vision"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-eye opacity-50 mr-1"></i> Vision
            </h3>
            <p class="text-xs opacity-50 mb-3">
              图片和贴纸的处理行为。需配合 vision 路由使用。
            </p>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label">压缩阈值 (px)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.vision.maxImageSize}
                  placeholder="1024"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">单轮最大图片</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.vision.maxImagesPerContext}
                  placeholder="3"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">Sticker 模式</span>
                <select
                  class="select select-xs select-bordered w-full"
                  bind:value={config.vision.stickerMode}
                >
                  <option value={undefined}>默认 (emoji_only)</option>
                  <option value="emoji_only">emoji_only</option><option
                    value="vision_cache">vision_cache</option
                  ><option value="vision_each">vision_each</option>
                </select></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">下载上限 (MB)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.vision.maxMediaDownloadSize}
                  placeholder="20"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">媒体保留天数</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.vision.mediaRetentionDays}
                  placeholder="3"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">Sticker 发送策略</span>
                <select
                  class="select select-xs select-bordered w-full"
                  bind:value={config.vision.stickerSendingMode}
                >
                  <option value={undefined}>全部允许（默认）</option>
                  <option value="allow_all">allow_all（全部允许）</option>
                  <option value="allow_listed">allow_listed（仅指定）</option>
                  <option value="disallow_all">disallow_all（全部禁止）</option>
                </select></label
              >
            </div>
          {/if}

          <!-- ══ Dashboard ══ -->
          {#if currentSection === "dashboard"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-gauge-high opacity-50 mr-1"></i> Dashboard
              <span class="restart-hint"
                ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
              >
            </h3>
            <p class="text-xs opacity-50 mb-3">
              监听地址、端口与访问 token。默认仅本机；公网请谨慎并务必设置强
              token。
            </p>
            <div class="cfg-grid-3">
              <label class="cfg-check"
                ><input
                  type="checkbox"
                  class="toggle toggle-xs"
                  bind:checked={config.dashboard.enabled}
                /><span>启用</span></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">主机名 / IP</span>
                <input
                  type="text"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.dashboard.host}
                  placeholder="127.0.0.1"
                /></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">端口</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.dashboard.port}
                  placeholder="6767"
                /></label
              >
            </div>
            <label class="cfg-field mt-2"
              ><span class="cfg-label">Token</span>
              <input
                type="password"
                class="input input-xs input-bordered w-full"
                bind:value={config.dashboard.token}
                on:focus={pwFocus}
                on:blur={pwBlur}
              /></label
            >
          {/if}

          <!-- ══ Subagent ══ -->
          {#if currentSection === "subagent"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-robot opacity-50 mr-1"></i> Subagent / CodeAct
            </h3>
            <p class="text-xs opacity-50 mb-3">
              CodeAct 执行引擎和注意力系统参数。
            </p>
            {#if config.subagent}
              <div class="cfg-grid-2">
                <label class="cfg-field"
                  ><span class="cfg-label"
                    ><i class="fa-solid fa-rotate-right restart-icon"></i> 最大 Sandbox</span
                  >
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.subagent.maxSandboxInstances}
                    placeholder="5"
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">空闲超时 (ms)</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.subagent.sandboxIdleTimeout}
                    placeholder="600000"
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">轮询间隔 (ms)</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.subagent.pollInterval}
                    placeholder="5000"
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">Alert 阈值</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    bind:value={config.subagent.alertEngagementThreshold}
                    placeholder="60"
                  /></label
                >
              </div>
              <div class="divider text-xs opacity-50 my-3">CodeAct</div>
              <div class="cfg-grid-3">
                <label class="cfg-field"
                  ><span class="cfg-label">最大轮次</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    value={config.subagent.codeAct?.maxTurns ?? ""}
                    on:input={(e) => {
                      if (!config.subagent.codeAct)
                        config.subagent.codeAct = {};
                      config.subagent.codeAct.maxTurns =
                        Number(e.target.value) || undefined;
                      config = config;
                    }}
                    placeholder="30"
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">执行超时 (ms)</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    value={config.subagent.codeAct?.maxExecutionTimeMs ?? ""}
                    on:input={(e) => {
                      if (!config.subagent.codeAct)
                        config.subagent.codeAct = {};
                      config.subagent.codeAct.maxExecutionTimeMs =
                        Number(e.target.value) || undefined;
                      config = config;
                    }}
                    placeholder="60000"
                  /></label
                >
                <label class="cfg-field"
                  ><span class="cfg-label">最大消息</span>
                  <input
                    type="number"
                    class="input input-xs input-bordered w-full"
                    value={config.subagent.codeAct?.maxSessionMessages ?? ""}
                    on:input={(e) => {
                      if (!config.subagent.codeAct)
                        config.subagent.codeAct = {};
                      config.subagent.codeAct.maxSessionMessages =
                        Number(e.target.value) || undefined;
                      config = config;
                    }}
                    placeholder="100"
                  /></label
                >
              </div>
            {/if}
          {/if}

          <!-- ══ Recording Pipeline ══ -->
          {#if currentSection === "recordingPipeline"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-tape opacity-50 mr-1"></i> Recording Pipeline
            </h3>
            <p class="text-xs opacity-50 mb-3">
              话题聚类 Pipeline 的缓冲区和刷新触发参数。控制消息积攒到何种程度才进行一次 LLM 话题分析。
            </p>
            <div class="cfg-grid-2">
              <label class="cfg-field"
                ><span class="cfg-label">最少消息数</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.recordingPipeline.minFlushSize}
                  placeholder="10"
                  min="1"
                /><span class="text-[10px] opacity-40">静默到期时 buffer 不足此数则跳过 flush</span></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">正常阈值 (条)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.recordingPipeline.normalThreshold}
                  placeholder="50"
                  min="5"
                /><span class="text-[10px] opacity-40">消息积攒到此数立即 flush</span></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">加速阈值 (条)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.recordingPipeline.eagerThreshold}
                  placeholder="15"
                  min="3"
                /><span class="text-[10px] opacity-40">检测到强信号后的降低阈值</span></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">正常静默 (ms)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.recordingPipeline.normalSilenceMs}
                  placeholder="120000"
                  min="10000"
                  step="10000"
                /><span class="text-[10px] opacity-40">无新消息多久后触发 flush（默认 2 分钟）</span></label
              >
              <label class="cfg-field"
                ><span class="cfg-label">加速静默 (ms)</span>
                <input
                  type="number"
                  class="input input-xs input-bordered w-full"
                  bind:value={config.recordingPipeline.eagerSilenceMs}
                  placeholder="30000"
                  min="5000"
                  step="5000"
                /><span class="text-[10px] opacity-40">强信号模式下的静默触发时间（默认 30 秒）</span></label
              >
            </div>
          {/if}

          <!-- ══ Environment Variables ══ -->
          {#if currentSection === "envVars"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-key opacity-50 mr-1"></i>
              环境变量
              <span class="restart-hint"
                ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
              >
            </h3>
            <p class="text-xs opacity-50 mb-3">
              配置注入到进程的环境变量。每个变量可选择作用于 Host（主进程）、Sandbox（沙盒执行环境）或 Both（两者皆可访问）。
            </p>
            <div class="overflow-x-auto">
              <table class="table table-xs w-full">
                <thead>
                  <tr>
                    <th class="text-xs opacity-60" style="width:30%">变量名</th>
                    <th class="text-xs opacity-60" style="width:40%">值</th>
                    <th class="text-xs opacity-60" style="width:20%">作用域</th>
                    <th class="text-xs opacity-60" style="width:10%"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each (config.envVars || []) as ev, idx}
                    <tr class="hover">
                      <td>
                        <input
                          type="text"
                          class="input input-xs input-bordered w-full font-mono"
                          bind:value={ev.key}
                          placeholder="VARIABLE_NAME"
                        />
                      </td>
                      <td>
                        <input
                          type="password"
                          class="input input-xs input-bordered w-full font-mono"
                          bind:value={ev.value}
                          placeholder="value"
                          on:focus={pwFocus}
                          on:blur={pwBlur}
                        />
                      </td>
                      <td>
                        <select
                          class="select select-xs select-bordered w-full"
                          bind:value={ev.scope}
                        >
                          <option value="both">Both</option>
                          <option value="host">Host</option>
                          <option value="sandbox">Sandbox</option>
                        </select>
                      </td>
                      <td>
                        <button
                          class="btn btn-xs btn-ghost btn-error"
                          on:click={() => removeEnvVar(idx)}
                          title="删除"
                        >
                          <i class="fa-solid fa-trash-can"></i>
                        </button>
                      </td>
                    </tr>
                  {/each}
                  {#if !config.envVars || config.envVars.length === 0}
                    <tr>
                      <td colspan="4" class="text-center text-xs opacity-30 py-4">
                        暂无环境变量。点击下方按钮添加。
                      </td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
            <button
              class="btn btn-sm btn-outline btn-primary mt-2"
              on:click={addEnvVar}
            >
              <i class="fa-solid fa-plus"></i> 添加环境变量
            </button>
            <div class="mt-3 text-xs opacity-40 space-y-1">
              <p><strong>Host</strong>：仅注入主进程，Sandbox 不可见。适用于敏感密钥、数据库连接等。</p>
              <p><strong>Sandbox</strong>：仅注入沙盒环境，主进程不可见。适用于 Skill 调用的第三方 API Key。</p>
              <p><strong>Both</strong>：同时注入主进程和沙盒。适用于共享配置（如 Tavily API Key）。</p>
            </div>
          {/if}

          <!-- ══ System Prompts ══ -->
          {#if currentSection === "systemPrompts"}
            <h3 class="card-title text-sm">
              <i class="fa-solid fa-file-lines opacity-50 mr-1"></i> System Prompts Override
            </h3>
            <p class="text-xs opacity-50 mb-3">
              编辑 system prompt 的 override 版本。Override 保存到 <code>workspace/system-prompts-overrides/</code>，读取时优先使用。
            </p>

            {#if promptsLoading}
              <div class="flex justify-center py-8">
                <span class="loading loading-spinner loading-md"></span>
              </div>
            {:else}
              <div class="flex gap-3 prompt-editor-layout">
                <!-- Tree View -->
                <div class="prompt-tree-panel">
                  {#each Object.entries(promptTree) as [dirName, dirNode]}
                    {@const dirPath = dirName}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <div
                      class="prompt-dir"
                      on:click={() => { expandedDirs.has(dirPath) ? expandedDirs.delete(dirPath) : expandedDirs.add(dirPath); expandedDirs = expandedDirs; }}
                    >
                      <i class="fa-solid fa-chevron-right text-[10px] opacity-40 transition-transform" style:transform={expandedDirs.has(dirPath) ? "rotate(90deg)" : ""}></i>
                      <i class="fa-solid fa-folder text-xs opacity-60"></i>
                      <span class="text-xs font-semibold">{dirName}</span>
                    </div>
                    {#if expandedDirs.has(dirPath) && dirNode.__children}
                      {#each Object.entries(dirNode.__children) as [fileName, fileNode]}
                        {#if fileNode.__file}
                          {@const fp = fileNode.__file}
                          <!-- svelte-ignore a11y-click-events-have-key-events -->
                          <div
                            class="prompt-file"
                            class:active={selectedPrompt === fp.relativePath}
                            on:click={() => selectPrompt(fp.relativePath)}
                          >
                            <i class="fa-solid fa-file-lines text-xs opacity-40"></i>
                            <span class="text-xs truncate">{fileName}</span>
                            {#if fp.hasOverride}
                              <span class="badge badge-xs badge-warning ml-auto">override</span>
                            {/if}
                          </div>
                        {/if}
                      {/each}
                    {/if}
                  {/each}
                </div>

                <!-- Editor -->
                <div class="flex-1 min-w-0">
                  {#if !selectedPrompt}
                    <div class="flex items-center justify-center h-40 opacity-30 text-sm">
                      <i class="fa-solid fa-arrow-left mr-2"></i>选择一个 prompt 文件进行编辑
                    </div>
                  {:else if promptDetailLoading}
                    <div class="flex justify-center py-8">
                      <span class="loading loading-spinner loading-md"></span>
                    </div>
                  {:else}
                    <div class="flex items-center gap-2 mb-2">
                      <span class="font-mono text-xs font-bold truncate">{selectedPrompt}</span>
                      {#if promptHasOverride}
                        <span class="badge badge-xs badge-warning">已覆盖</span>
                      {:else}
                        <span class="badge badge-xs badge-ghost">原始</span>
                      {/if}
                    </div>
                    <textarea
                      class="textarea textarea-bordered w-full font-mono text-xs prompt-textarea"
                      rows="20"
                      bind:value={promptEditorContent}
                      spellcheck="false"
                    ></textarea>
                    <div class="flex gap-2 mt-2">
                      <button
                        class="btn btn-sm btn-primary"
                        on:click={savePromptOverride}
                        disabled={promptSaving}
                      >
                        <i class="fa-solid fa-floppy-disk"></i>
                        {promptSaving ? "保存中..." : "保存 Override"}
                      </button>
                      <button
                        class="btn btn-sm btn-ghost"
                        on:click={resetPromptEditor}
                        title="恢复编辑器内容为原始版本"
                      >
                        <i class="fa-solid fa-arrow-rotate-left"></i> 重置为原始
                      </button>
                      {#if promptHasOverride}
                        <button
                          class="btn btn-sm btn-outline btn-error"
                          on:click={deletePromptOverride}
                          title="删除 override 文件，恢复到原始版本"
                        >
                          <i class="fa-solid fa-trash-can"></i> 删除 Override
                        </button>
                      {/if}
                    </div>
                    {#if promptHasOverride}
                      <div class="mt-3">
                        <details class="collapse collapse-arrow bg-base-200 rounded-lg">
                          <summary class="collapse-title text-xs font-medium py-2 min-h-0">
                            <i class="fa-solid fa-eye mr-1 opacity-50"></i>查看原始版本
                          </summary>
                          <div class="collapse-content">
                            <pre class="text-xs opacity-60 whitespace-pre-wrap mt-1">{promptOriginal}</pre>
                          </div>
                        </details>
                      </div>
                    {/if}
                  {/if}
                </div>
              </div>
            {/if}
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
  .cfg-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  .cfg-grid-3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  .cfg-field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .cfg-label {
    font-size: 0.7rem;
    opacity: 0.6;
    padding-left: 1px;
  }
  .cfg-check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.25rem 0;
  }

  /* ── Profile card ── */
  .profile-card {
    border-left: 3px solid var(--color-primary);
    padding: 0.75rem;
    border-radius: 0.25rem;
    background: var(--color-base-200);
    margin-bottom: 0.5rem;
  }

  /* ── Routing row ── */
  .routing-row {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: var(--color-base-200);
  }

  /* ── Restart indicators ── */
  .restart-hint {
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
    .profile-card .cfg-grid-2 {
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
  .prompt-editor-layout {
    min-height: 300px;
  }
  .prompt-tree-panel {
    width: 220px;
    flex-shrink: 0;
    max-height: 600px;
    overflow-y: auto;
    border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
    border-radius: 0.5rem;
    padding: 0.5rem;
  }
  .prompt-dir {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.4rem;
    border-radius: 0.25rem;
    cursor: pointer;
    user-select: none;
  }
  .prompt-dir:hover {
    background: var(--color-base-200);
  }
  .prompt-file {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.4rem 0.25rem 1.6rem;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: background 0.1s;
  }
  .prompt-file:hover {
    background: var(--color-base-200);
  }
  .prompt-file.active {
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
  }
  .prompt-textarea {
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    line-height: 1.5;
    tab-size: 2;
    resize: vertical;
  }
</style>
