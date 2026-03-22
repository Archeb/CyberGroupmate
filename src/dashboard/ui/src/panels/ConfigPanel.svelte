<script>
  import { onMount } from 'svelte';
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';

  let config = null;
  let originalConfig = null; // for tracking which fields changed
  let loading = true;
  let saving = false;
  let toast = null;
  let toastTimer = null;
  let currentSection = 'llmProfiles';

  // Profile test results
  let profileTests = {};
  let showNewProfile = false;
  let newProfileName = '';
  let newKeyword = '';

  const SECTIONS = [
    { id: 'llmProfiles', label: 'LLM Profiles', icon: 'fa-microchip' },
    { id: 'llmRouting', label: '组件路由', icon: 'fa-route' },
    { id: 'persona', label: '人格设置', icon: 'fa-user-astronaut' },
    { id: 'timezone', label: '时区', icon: 'fa-clock' },
    { id: 'notification', label: '唤醒词', icon: 'fa-bell' },
    { id: 'telegram', label: 'Telegram', icon: 'fa-paper-plane' },
    { id: 'reflection', label: 'Reflection', icon: 'fa-brain' },
    { id: 'contextBudget', label: 'Context Budget', icon: 'fa-sliders' },
    { id: 'embedding', label: 'Embedding', icon: 'fa-vector-square' },
    { id: 'vision', label: 'Vision', icon: 'fa-eye' },
    { id: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high' },
    { id: 'subagent', label: 'Subagent', icon: 'fa-robot' },
    { id: 'tavily', label: 'Tavily', icon: 'fa-magnifying-glass' },
  ];

  // Sections/fields requiring restart
  const RESTART_SECTIONS = new Set(['embedding', 'dashboard']);
  const RESTART_FIELDS = {
    telegram: ['mode', 'botToken', 'apiId', 'apiHash', 'phone'],
    subagent: ['maxSandboxInstances'],
  };

  const ROUTING_COMPONENTS = [
    { key: 'attend', label: '注意力决策', desc: '判断是否需要回复' },
    { key: 'session', label: 'CodeAct 交互', desc: '生成回复内容' },
    { key: 'fast_path', label: '快速回复', desc: '轻量级即时回复' },
    { key: 'recording', label: '话题聚类', desc: 'Triage + 聚类分析' },
    { key: 'reflection', label: '反思引擎', desc: '人物画像/总结' },
    { key: 'compact', label: '上下文压缩', desc: '对话历史摘要' },
    { key: 'memory', label: '记忆检索', desc: 'Deep recall' },
    { key: 'vision', label: '视觉描述', desc: '图片/贴纸描述' },
  ];

  $: if ($activeTab === 'config' && !config) loadConfigData();

  async function loadConfigData() {
    loading = true;
    try {
      config = await api('/config');
      if (!config.contextBudget) config.contextBudget = {};
      if (!config.vision) config.vision = {};
      if (!config.dashboard) config.dashboard = {};
      if (!config.subagent) config.subagent = {};
      if (!config.telegram.humanizedDelay) {
        config.telegram.humanizedDelay = { enabled: false, msPerChar: 50, minDelay: 500, maxDelay: 5000 };
      }
      if (!config.reflection.mergeThresholds) config.reflection.mergeThresholds = {};
      if (!config.reflection.tierLimits) config.reflection.tierLimits = {};
      originalConfig = JSON.parse(JSON.stringify(config));
    } catch (err) {
      showToast('加载配置失败: ' + err, 'error');
    }
    loading = false;
  }

  function hasRestartChanges() {
    if (!originalConfig || !config) return false;
    // Check full restart sections
    for (const sec of RESTART_SECTIONS) {
      if (JSON.stringify(config[sec]) !== JSON.stringify(originalConfig[sec])) return true;
    }
    // Check specific fields
    for (const [sec, fields] of Object.entries(RESTART_FIELDS)) {
      for (const f of fields) {
        if (config[sec]?.[f] !== originalConfig[sec]?.[f]) return true;
      }
    }
    if (config.tavilyApiKey !== originalConfig.tavilyApiKey) return true;
    return false;
  }

  async function saveAll() {
    saving = true;
    const needsRestart = hasRestartChanges();
    try {
      const res = await api('/config', { method: 'PUT', body: config });
      if (res.ok) {
        originalConfig = JSON.parse(JSON.stringify(config));
        if (needsRestart) {
          showToast('✅ 配置已保存。部分修改需要重启服务才能生效，点击底部「重启服务」按钮。', 'warning');
        } else {
          showToast('✅ 配置已保存并即时生效', 'success');
        }
      } else {
        const errMsg = res.errors ? res.errors.join('\n') : (res.error || '未知错误');
        showToast('❌ 验证失败:\n' + errMsg, 'error');
      }
    } catch (err) {
      showToast('❌ 保存失败: ' + err, 'error');
    }
    saving = false;
  }

  async function testProfile(name) {
    const p = config.llmProfiles[name];
    if (!p) return;
    profileTests[name] = { testing: true };
    profileTests = profileTests;
    try {
      const res = await api('/config/test-profile', { method: 'POST', body: p });
      profileTests[name] = res;
    } catch (err) {
      profileTests[name] = { ok: false, error: String(err) };
    }
    profileTests = profileTests;
  }

  async function restartService() {
    if (!confirm('确定要重启服务吗？需要有进程管理器（pm2/systemd）才能自动恢复。')) return;
    try {
      await api('/restart', { method: 'POST' });
      showToast('🔄 服务正在重启...', 'success');
    } catch { showToast('发送重启信号失败', 'error'); }
  }

  function showToast(msg, type = 'info') {
    toast = { msg, type };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; }, type === 'error' ? 8000 : 5000);
  }

  function addProfile() {
    if (!newProfileName.trim()) return;
    if (config.llmProfiles[newProfileName]) { showToast('名称已存在', 'error'); return; }
    config.llmProfiles[newProfileName] = { provider: 'openai', baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 8192 };
    config = config;
    newProfileName = '';
    showNewProfile = false;
  }
  function deleteProfile(name) {
    if (!confirm(`删除 Profile "${name}"？`)) return;
    delete config.llmProfiles[name];
    config = config;
  }
  function addKeyword() {
    const kw = newKeyword.trim();
    if (!kw) return;
    if (!config.notification.mentionKeywords.includes(kw)) {
      config.notification.mentionKeywords = [...config.notification.mentionKeywords, kw];
    }
    newKeyword = '';
  }
  function removeKeyword(kw) {
    config.notification.mentionKeywords = config.notification.mentionKeywords.filter(k => k !== kw);
  }
  function getProfileNames() { return config ? Object.keys(config.llmProfiles) : []; }

  function getRoutingArray(key) {
    const v = config.llmRouting[key];
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }
  function addRoutingProfile(compKey, profileName) {
    if (!profileName) return;
    const arr = getRoutingArray(compKey);
    if (!arr.includes(profileName)) {
      arr.push(profileName);
      config.llmRouting[compKey] = arr.length === 1 ? arr[0] : arr;
      config = config;
    }
  }
  function removeRoutingProfile(compKey, idx) {
    const arr = getRoutingArray(compKey);
    arr.splice(idx, 1);
    config.llmRouting[compKey] = arr.length === 0 ? undefined : arr.length === 1 ? arr[0] : arr;
    config = config;
  }

  // Restart indicator helper
  function needsRestart(section, field) {
    if (RESTART_SECTIONS.has(section)) return true;
    if (RESTART_FIELDS[section]?.includes(field)) return true;
    return false;
  }
</script>

{#if loading || !config}
  <div class="flex justify-center items-center h-64"><span class="loading loading-spinner loading-lg"></span></div>
{:else}
  <div class="config-layout">
    <!-- Left: Section Nav -->
    <nav class="config-nav">
      {#each SECTIONS as sec}
        <button class="config-nav-item" class:active={currentSection === sec.id}
          on:click={() => currentSection = sec.id}>
          <i class="fa-solid {sec.icon} fa-fw"></i>
          <span>{sec.label}</span>
          {#if RESTART_SECTIONS.has(sec.id)}
            <i class="fa-solid fa-rotate-right restart-icon" title="此区段修改需重启"></i>
          {/if}
        </button>
      {/each}
    </nav>

    <!-- Right: Editor -->
    <div class="config-editor">

      <!-- ══ LLM Profiles ══ -->
      {#if currentSection === 'llmProfiles'}
        <div class="section-header">
          <h3><i class="fa-solid fa-microchip"></i> LLM Profiles</h3>
          <p>定义多个命名 LLM 配置（provider/key/model），在 Routing 中引用。</p>
        </div>
        {#each Object.entries(config.llmProfiles) as [name, p]}
          <div class="card bg-base-200 mb-3">
            <div class="card-body p-3">
              <div class="flex justify-between items-center mb-2">
                <h4 class="font-mono font-bold text-sm"><i class="fa-solid fa-cube mr-1 opacity-40"></i>{name}</h4>
                <div class="flex gap-1">
                  <button class="btn btn-xs btn-outline btn-info" on:click={() => testProfile(name)}
                    disabled={profileTests[name]?.testing}>
                    <i class="fa-solid fa-plug"></i>
                    {profileTests[name]?.testing ? '测试中...' : '测试连通性'}
                  </button>
                  <button class="btn btn-xs btn-outline btn-error" on:click={() => deleteProfile(name)}>
                    <i class="fa-solid fa-trash-can"></i>
                  </button>
                </div>
              </div>
              {#if profileTests[name] && !profileTests[name].testing}
                <div class="alert alert-sm mb-2 py-1" class:alert-success={profileTests[name].ok} class:alert-error={!profileTests[name].ok}>
                  <span class="text-xs">
                    {profileTests[name].ok
                      ? `✅ 连接成功 · ${profileTests[name].latency}ms · model: ${profileTests[name].model || '?'}`
                      : `❌ ${profileTests[name].error || `HTTP ${profileTests[name].status}`}`}
                  </span>
                </div>
              {/if}
              <div class="grid grid-cols-2 gap-2">
                <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Provider</span></div>
                  <select class="select select-xs select-bordered" bind:value={p.provider}>
                    <option value="openai">openai (兼容)</option><option value="anthropic">anthropic</option>
                  </select></label>
                <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Model</span></div>
                  <input type="text" class="input input-xs input-bordered" bind:value={p.model} placeholder="gpt-4o" /></label>
                <label class="form-control col-span-2"><div class="label py-0"><span class="label-text text-xs">Base URL</span></div>
                  <input type="text" class="input input-xs input-bordered" bind:value={p.baseUrl} placeholder="https://api.openai.com/v1" /></label>
                <label class="form-control col-span-2"><div class="label py-0"><span class="label-text text-xs">API Key</span></div>
                  <input type="password" class="input input-xs input-bordered" bind:value={p.apiKey} /></label>
                <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Temperature</span></div>
                  <input type="number" class="input input-xs input-bordered" bind:value={p.temperature} min="0" max="2" step="0.1" /></label>
                <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Max Tokens</span></div>
                  <input type="number" class="input input-xs input-bordered" bind:value={p.maxTokens} min="1" /></label>
                <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Max Context Tokens</span></div>
                  <input type="number" class="input input-xs input-bordered" bind:value={p.maxContextTokens} placeholder="(默认)" /></label>
                <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Thinking Level</span></div>
                  <select class="select select-xs select-bordered" bind:value={p.thinkingLevel}>
                    <option value={undefined}>无</option><option value="none">none</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
                  </select></label>
                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={p.vision} /><span class="text-xs">Vision</span></label>
                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" class="checkbox checkbox-xs" checked={p.supportsPrefill !== false}
                  on:change={(e) => { p.supportsPrefill = e.target.checked ? undefined : false; config = config; }} /><span class="text-xs">Prefill</span></label>
              </div>
            </div>
          </div>
        {/each}
        <div class="flex items-center gap-2 mt-2">
          {#if showNewProfile}
            <input type="text" class="input input-sm input-bordered" bind:value={newProfileName} placeholder="新 Profile 名称"
              on:keydown={(e) => e.key === 'Enter' && addProfile()} />
            <button class="btn btn-sm btn-primary" on:click={addProfile}>添加</button>
            <button class="btn btn-sm btn-ghost" on:click={() => showNewProfile = false}>取消</button>
          {:else}
            <button class="btn btn-sm btn-outline btn-primary" on:click={() => showNewProfile = true}>
              <i class="fa-solid fa-plus"></i> 新建 Profile
            </button>
          {/if}
        </div>
      {/if}

      <!-- ══ LLM Routing ══ -->
      {#if currentSection === 'llmRouting'}
        <div class="section-header">
          <h3><i class="fa-solid fa-route"></i> 组件级 LLM 路由</h3>
          <p>为每个系统组件分配 LLM profile。支持多个（fallback chain：第一个失败自动切换下一个）。</p>
        </div>
        <div class="space-y-3">
          {#each ROUTING_COMPONENTS as comp}
            <div class="bg-base-200 rounded-lg p-3">
              <div class="mb-1">
                <span class="font-mono text-xs font-bold">{comp.key}</span>
                <span class="text-xs opacity-50 ml-1">— {comp.desc}</span>
              </div>
              <!-- Current assignments -->
              <div class="flex flex-wrap gap-1 mb-2">
                {#each getRoutingArray(comp.key) as pn, idx}
                  <div class="badge badge-primary badge-sm gap-1">
                    <span class="opacity-60 text-[10px]">#{idx + 1}</span> {pn}
                    <button class="btn btn-ghost btn-xs px-0 min-h-0 h-auto" on:click={() => removeRoutingProfile(comp.key, idx)}>
                      <i class="fa-solid fa-xmark text-[10px]"></i>
                    </button>
                  </div>
                {/each}
                {#if getRoutingArray(comp.key).length === 0}
                  <span class="text-xs opacity-40 italic">未分配</span>
                {/if}
              </div>
              <!-- Add dropdown -->
              <select class="select select-xs select-bordered w-48"
                on:change={(e) => { addRoutingProfile(comp.key, e.target.value); e.target.value = ''; }}>
                <option value="" disabled selected>+ 添加 profile...</option>
                {#each getProfileNames().filter(pn => !getRoutingArray(comp.key).includes(pn)) as pn}
                  <option value={pn}>{pn}</option>
                {/each}
              </select>
            </div>
          {/each}
        </div>
      {/if}

      <!-- ══ Persona ══ -->
      {#if currentSection === 'persona'}
        <div class="section-header">
          <h3><i class="fa-solid fa-user-astronaut"></i> 人格设置</h3>
          <p>Agent 的名字和人格描述，注入到所有 LLM system prompt 中。</p>
        </div>
        <label class="form-control mb-3">
          <div class="label"><span class="label-text text-xs">Agent 名字</span></div>
          <input type="text" class="input input-sm input-bordered" bind:value={config.persona.name} />
        </label>
        <label class="form-control">
          <div class="label"><span class="label-text text-xs">人格描述</span></div>
          <textarea class="textarea textarea-bordered textarea-sm" rows="6" bind:value={config.persona.description}></textarea>
        </label>
      {/if}

      <!-- ══ Timezone ══ -->
      {#if currentSection === 'timezone'}
        <div class="section-header">
          <h3><i class="fa-solid fa-clock"></i> 全局时区</h3>
          <p>影响 prompt 中的时间显示和作息判断。使用 IANA 标识符。</p>
        </div>
        <input type="text" class="input input-sm input-bordered w-full" bind:value={config.timezone}
          placeholder="Asia/Shanghai" list="tz-list" />
        <datalist id="tz-list">
          <option value="Asia/Shanghai" /><option value="Asia/Tokyo" /><option value="America/New_York" />
          <option value="America/Los_Angeles" /><option value="Europe/London" /><option value="UTC" />
        </datalist>
      {/if}

      <!-- ══ Notification ══ -->
      {#if currentSection === 'notification'}
        <div class="section-header">
          <h3><i class="fa-solid fa-bell"></i> 唤醒关键词</h3>
          <p>消息包含这些关键词时立即触发 Agent 处理（@提及/名字唤醒）。</p>
        </div>
        <div class="flex flex-wrap gap-1 mb-3">
          {#each config.notification.mentionKeywords as kw}
            <div class="badge badge-outline badge-sm gap-1">
              {kw}
              <button class="btn btn-ghost btn-xs px-0 min-h-0 h-auto" on:click={() => removeKeyword(kw)}>
                <i class="fa-solid fa-xmark text-[10px]"></i>
              </button>
            </div>
          {/each}
        </div>
        <div class="flex gap-2">
          <input type="text" class="input input-sm input-bordered flex-1" bind:value={newKeyword}
            placeholder="输入关键词..." on:keydown={(e) => e.key === 'Enter' && addKeyword()} />
          <button class="btn btn-sm btn-primary" on:click={addKeyword}><i class="fa-solid fa-plus"></i> 添加</button>
        </div>
      {/if}

      <!-- ══ Telegram ══ -->
      {#if currentSection === 'telegram'}
        <div class="section-header">
          <h3><i class="fa-solid fa-paper-plane"></i> Telegram 设置</h3>
          <p>连接参数和发送行为。</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="form-control">
            <div class="label"><span class="label-text text-xs"><i class="fa-solid fa-rotate-right restart-icon mr-1"></i>连接模式</span></div>
            <select class="select select-sm select-bordered" bind:value={config.telegram.mode}>
              <option value="bot">bot</option><option value="userbot">userbot</option>
            </select></label>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs"><i class="fa-solid fa-rotate-right restart-icon mr-1"></i>Bot Token</span></div>
            <input type="password" class="input input-sm input-bordered" bind:value={config.telegram.botToken} /></label>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs"><i class="fa-solid fa-rotate-right restart-icon mr-1"></i>API ID</span></div>
            <input type="text" class="input input-sm input-bordered" bind:value={config.telegram.apiId} /></label>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs"><i class="fa-solid fa-rotate-right restart-icon mr-1"></i>API Hash</span></div>
            <input type="password" class="input input-sm input-bordered" bind:value={config.telegram.apiHash} /></label>
          <label class="form-control col-span-2">
            <div class="label"><span class="label-text text-xs"><i class="fa-solid fa-rotate-right restart-icon mr-1"></i>手机号 (userbot 模式)</span></div>
            <input type="text" class="input input-sm input-bordered" bind:value={config.telegram.phone} placeholder="+86..." /></label>
        </div>
        <div class="divider text-xs opacity-50 my-3">拟人化发送延迟</div>
        <label class="flex items-center gap-2 cursor-pointer mb-2">
          <input type="checkbox" class="toggle toggle-sm" bind:checked={config.telegram.humanizedDelay.enabled} />
          <span class="text-sm">启用拟人化延迟</span>
        </label>
        {#if config.telegram.humanizedDelay.enabled}
          <div class="grid grid-cols-3 gap-2">
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">每字符 ms</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.telegram.humanizedDelay.msPerChar} /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">最小延迟 ms</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.telegram.humanizedDelay.minDelay} /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">最大延迟 ms</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.telegram.humanizedDelay.maxDelay} /></label>
          </div>
        {/if}
      {/if}

      <!-- ══ Reflection ══ -->
      {#if currentSection === 'reflection'}
        <div class="section-header">
          <h3><i class="fa-solid fa-brain"></i> Reflection 反思设置</h3>
          <p>控制反思引擎的触发条件、渐进合并阈值和作息时间。</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="form-control"><div class="label"><span class="label-text text-xs">Profile</span></div>
            <select class="select select-sm select-bordered" bind:value={config.reflection.profile}>
              <option value={undefined}>（跟随 routing）</option>
              {#each getProfileNames() as pn}<option value={pn}>{pn}</option>{/each}
            </select></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">冷场阈值 (秒)</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.reflection.silenceThreshold} placeholder="7200" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">最大间隔 (秒)</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.reflection.maxInterval} placeholder="86400" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">检查间隔 (秒)</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.reflection.checkInterval} placeholder="300" /></label>
        </div>
        <div class="divider text-xs opacity-50 my-3">渐进合并阈值 (天)</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Episode → Week</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.reflection.mergeThresholds.episodeToWeek} placeholder="7" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Week → Month</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.reflection.mergeThresholds.weekToMonth} placeholder="30" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Month → Quarter</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.reflection.mergeThresholds.monthToQuarter} placeholder="90" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Quarter → Year</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.reflection.mergeThresholds.quarterToYear} placeholder="365" /></label>
        </div>
        <div class="divider text-xs opacity-50 my-3">作息时间</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">起始小时</span></div>
            <input type="number" class="input input-xs input-bordered"
              value={config.reflection.awakeHours?.[0] ?? ''}
              on:input={(e) => { if (!config.reflection.awakeHours) config.reflection.awakeHours = [8, 24]; config.reflection.awakeHours[0] = Number(e.target.value); config = config; }}
              placeholder="8" min="0" max="23" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">结束小时</span></div>
            <input type="number" class="input input-xs input-bordered"
              value={config.reflection.awakeHours?.[1] ?? ''}
              on:input={(e) => { if (!config.reflection.awakeHours) config.reflection.awakeHours = [8, 24]; config.reflection.awakeHours[1] = Number(e.target.value); config = config; }}
              placeholder="24" min="0" max="24" /></label>
        </div>
      {/if}

      <!-- ══ Context Budget ══ -->
      {#if currentSection === 'contextBudget'}
        <div class="section-header">
          <h3><i class="fa-solid fa-sliders"></i> Context Budget</h3>
          <p>上下文压缩的 token 预算分配。留空使用默认值。</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="form-control"><div class="label"><span class="label-text text-xs">有效上下文窗口 (tokens)</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.contextBudget.effectiveContextWindow} placeholder="32000" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">Output 预留 (tokens)</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.contextBudget.outputReserve} placeholder="4096" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">System Prompt 比例</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.contextBudget.systemPromptRatio} placeholder="0.20" step="0.05" min="0" max="1" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">Briefing 比例</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.contextBudget.briefingRatio} placeholder="0.15" step="0.05" min="0" max="1" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">近期消息比例</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.contextBudget.recentHistoryRatio} placeholder="0.50" step="0.05" min="0" max="1" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">最少保留消息</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.contextBudget.minRecentMessages} placeholder="6" /></label>
          <label class="form-control col-span-2"><div class="label"><span class="label-text text-xs">Briefing 最大 tokens</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.contextBudget.maxBriefingTokens} placeholder="3000" /></label>
        </div>
      {/if}

      <!-- ══ Embedding ══ -->
      {#if currentSection === 'embedding'}
        <div class="section-header">
          <h3><i class="fa-solid fa-vector-square"></i> Embedding 向量化
            <span class="restart-hint"><i class="fa-solid fa-rotate-right"></i> 修改需重启</span>
          </h3>
          <p>向量化提供者和参数。切换后已有向量数据可能不兼容。</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="form-control"><div class="label"><span class="label-text text-xs">Provider</span></div>
            <select class="select select-sm select-bordered" bind:value={config.embedding.provider}>
              <option value="local">local (本地 hash)</option><option value="openai">openai (API)</option>
            </select></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">相似度度量</span></div>
            <select class="select select-sm select-bordered" bind:value={config.embedding.similarityMetric}>
              <option value="cosine">cosine</option><option value="dot_product">dot_product</option>
              <option value="euclidean">euclidean</option><option value="manhattan">manhattan</option>
            </select></label>
          {#if config.embedding.provider === 'openai'}
            <label class="form-control col-span-2"><div class="label"><span class="label-text text-xs">Base URL</span></div>
              <input type="text" class="input input-sm input-bordered" bind:value={config.embedding.baseUrl} /></label>
            <label class="form-control col-span-2"><div class="label"><span class="label-text text-xs">API Key</span></div>
              <input type="password" class="input input-sm input-bordered" bind:value={config.embedding.apiKey} /></label>
            <label class="form-control"><div class="label"><span class="label-text text-xs">Model</span></div>
              <input type="text" class="input input-sm input-bordered" bind:value={config.embedding.model} /></label>
            <label class="form-control"><div class="label"><span class="label-text text-xs">Dimensions</span></div>
              <input type="number" class="input input-sm input-bordered" bind:value={config.embedding.dimensions} /></label>
          {/if}
        </div>
      {/if}

      <!-- ══ Vision ══ -->
      {#if currentSection === 'vision'}
        <div class="section-header">
          <h3><i class="fa-solid fa-eye"></i> Vision 看图设置</h3>
          <p>图片和贴纸的处理行为。需配合 vision 路由使用。</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="form-control"><div class="label"><span class="label-text text-xs">压缩阈值 (px)</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.vision.maxImageSize} placeholder="1024" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">单轮最大图片</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.vision.maxImagesPerContext} placeholder="3" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">Sticker 模式</span></div>
            <select class="select select-sm select-bordered" bind:value={config.vision.stickerMode}>
              <option value={undefined}>默认 (emoji_only)</option>
              <option value="emoji_only">emoji_only</option><option value="vision_cache">vision_cache</option><option value="vision_each">vision_each</option>
            </select></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">下载上限 (MB)</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.vision.maxMediaDownloadSize} placeholder="20" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">媒体保留天数</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.vision.mediaRetentionDays} placeholder="3" /></label>
        </div>
      {/if}

      <!-- ══ Dashboard ══ -->
      {#if currentSection === 'dashboard'}
        <div class="section-header">
          <h3><i class="fa-solid fa-gauge-high"></i> Dashboard 设置
            <span class="restart-hint"><i class="fa-solid fa-rotate-right"></i> 修改需重启</span>
          </h3>
          <p>Dashboard 服务端口和访问 token。</p>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="toggle toggle-sm" bind:checked={config.dashboard.enabled} />
            <span class="text-sm">启用</span>
          </label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">端口</span></div>
            <input type="number" class="input input-sm input-bordered" bind:value={config.dashboard.port} placeholder="6767" /></label>
          <label class="form-control"><div class="label"><span class="label-text text-xs">Token</span></div>
            <input type="password" class="input input-sm input-bordered" bind:value={config.dashboard.token} /></label>
        </div>
      {/if}

      <!-- ══ Subagent ══ -->
      {#if currentSection === 'subagent'}
        <div class="section-header">
          <h3><i class="fa-solid fa-robot"></i> Subagent / CodeAct</h3>
          <p>CodeAct 执行引擎和注意力系统的行为参数。</p>
        </div>
        {#if config.subagent}
          <div class="grid grid-cols-2 gap-3">
            <label class="form-control"><div class="label"><span class="label-text text-xs"><i class="fa-solid fa-rotate-right restart-icon mr-1"></i>最大 Sandbox 实例</span></div>
              <input type="number" class="input input-sm input-bordered" bind:value={config.subagent.maxSandboxInstances} placeholder="5" /></label>
            <label class="form-control"><div class="label"><span class="label-text text-xs">Sandbox 空闲超时 (ms)</span></div>
              <input type="number" class="input input-sm input-bordered" bind:value={config.subagent.sandboxIdleTimeout} placeholder="600000" /></label>
            <label class="form-control"><div class="label"><span class="label-text text-xs">轮询间隔 (ms)</span></div>
              <input type="number" class="input input-sm input-bordered" bind:value={config.subagent.pollInterval} placeholder="5000" /></label>
            <label class="form-control"><div class="label"><span class="label-text text-xs">Alert Engagement 阈值</span></div>
              <input type="number" class="input input-sm input-bordered" bind:value={config.subagent.alertEngagementThreshold} placeholder="60" /></label>
          </div>
          <div class="divider text-xs opacity-50 my-3">CodeAct</div>
          <div class="grid grid-cols-3 gap-3">
            <label class="form-control"><div class="label"><span class="label-text text-xs">最大轮次</span></div>
              <input type="number" class="input input-sm input-bordered" value={config.subagent.codeAct?.maxTurns ?? ''}
                on:input={(e) => { if (!config.subagent.codeAct) config.subagent.codeAct = {}; config.subagent.codeAct.maxTurns = Number(e.target.value) || undefined; config = config; }} placeholder="30" /></label>
            <label class="form-control"><div class="label"><span class="label-text text-xs">执行超时 (ms)</span></div>
              <input type="number" class="input input-sm input-bordered" value={config.subagent.codeAct?.maxExecutionTimeMs ?? ''}
                on:input={(e) => { if (!config.subagent.codeAct) config.subagent.codeAct = {}; config.subagent.codeAct.maxExecutionTimeMs = Number(e.target.value) || undefined; config = config; }} placeholder="60000" /></label>
            <label class="form-control"><div class="label"><span class="label-text text-xs">Session 最大消息</span></div>
              <input type="number" class="input input-sm input-bordered" value={config.subagent.codeAct?.maxSessionMessages ?? ''}
                on:input={(e) => { if (!config.subagent.codeAct) config.subagent.codeAct = {}; config.subagent.codeAct.maxSessionMessages = Number(e.target.value) || undefined; config = config; }} placeholder="100" /></label>
          </div>
        {/if}
      {/if}

      <!-- ══ Tavily ══ -->
      {#if currentSection === 'tavily'}
        <div class="section-header">
          <h3><i class="fa-solid fa-magnifying-glass"></i> Tavily 网络搜索
            <span class="restart-hint"><i class="fa-solid fa-rotate-right"></i> 修改需重启</span>
          </h3>
          <p>Tavily Search API key，用于 subagent 联网搜索。</p>
        </div>
        <label class="form-control">
          <input type="password" class="input input-sm input-bordered w-full" bind:value={config.tavilyApiKey} placeholder="tvly-..." />
        </label>
      {/if}

    </div>
  </div>

  <!-- Bottom Action Bar -->
  <div class="config-action-bar">
    <button class="btn btn-primary btn-sm" on:click={saveAll} disabled={saving}>
      <i class="fa-solid fa-floppy-disk"></i> {saving ? '保存中...' : '保存配置'}
    </button>
    <button class="btn btn-ghost btn-sm" on:click={() => { config = null; loadConfigData(); }}>
      <i class="fa-solid fa-arrow-rotate-left"></i> 重置
    </button>
    <div class="flex-1"></div>
    <button class="btn btn-error btn-sm btn-outline" on:click={restartService}>
      <i class="fa-solid fa-rotate-right"></i> 重启服务
    </button>
  </div>

  <!-- Toast -->
  {#if toast}
    <div class="toast toast-top toast-center z-50">
      <div class="alert py-2 px-4 shadow-lg" class:alert-success={toast.type === 'success'} class:alert-error={toast.type === 'error'} class:alert-warning={toast.type === 'warning'} class:alert-info={toast.type === 'info'}>
        <span class="text-sm whitespace-pre-wrap">{toast.msg}</span>
      </div>
    </div>
  {/if}
{/if}

<style>
  .config-layout {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 1rem;
    min-height: 60vh;
  }
  .config-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 1rem;
    align-self: start;
  }
  .config-nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s;
    background: transparent;
    border: none;
    color: inherit;
    opacity: 0.7;
  }
  .config-nav-item:hover { opacity: 1; background: var(--color-base-200); }
  .config-nav-item.active {
    opacity: 1;
    background: var(--color-primary);
    color: var(--color-primary-content);
  }
  .config-nav-item .restart-icon {
    margin-left: auto;
    font-size: 0.6rem;
    opacity: 0.5;
    color: var(--color-warning);
  }
  .config-nav-item.active .restart-icon { color: var(--color-primary-content); opacity: 0.7; }

  .config-editor {
    min-width: 0;
  }
  .section-header {
    margin-bottom: 1rem;
  }
  .section-header h3 {
    font-size: 1rem;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }
  .section-header h3 i { margin-right: 0.4rem; opacity: 0.6; }
  .section-header p {
    font-size: 0.75rem;
    opacity: 0.5;
  }

  .restart-hint {
    font-size: 0.65rem;
    font-weight: 400;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
    margin-left: 0.5rem;
    vertical-align: middle;
  }
  :global(.restart-icon) {
    font-size: 0.6rem;
    color: var(--color-warning);
    opacity: 0.7;
  }

  .config-action-bar {
    position: sticky;
    bottom: 0;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.75rem 1rem;
    margin-top: 1rem;
    background: var(--color-base-200);
    border-top: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent);
    border-radius: 0.75rem 0.75rem 0 0;
    z-index: 10;
  }
</style>
