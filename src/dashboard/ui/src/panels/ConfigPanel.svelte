<script>
  import { onMount } from 'svelte';
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';

  let config = null;
  let loading = true;
  let saving = false;
  let toast = null;
  let toastTimer = null;

  // track expand/collapse per section
  let expanded = {
    llmProfiles: true,
    llmRouting: true,
    persona: true,
    timezone: false,
    notification: false,
    telegram: false,
    reflection: false,
    contextBudget: false,
    embedding: false,
    vision: false,
    dashboard: false,
    subagent: false,
    tavily: false,
  };

  // Profile test results: { profileName: { ok, latency, error, testing } }
  let profileTests = {};

  // New profile modal
  let showNewProfile = false;
  let newProfileName = '';

  // Tag input state for mentionKeywords
  let newKeyword = '';

  const ROUTING_COMPONENTS = [
    { key: 'attend', label: '注意力决策', desc: '判断是否需要回复（attend-handler）' },
    { key: 'session', label: 'CodeAct 交互', desc: '实际生成回复（session-runner）' },
    { key: 'fast_path', label: '快速回复', desc: '轻量级即时回复（fast-path-handler）' },
    { key: 'recording', label: '话题聚类', desc: '话题 Triage + 聚类分析（recording-pipeline）' },
    { key: 'reflection', label: '反思引擎', desc: '人物画像/话题总结（reflection）' },
    { key: 'compact', label: '上下文压缩', desc: '对话历史摘要（context-manager compact）' },
    { key: 'memory', label: '记忆检索', desc: 'Deep recall / 意图解析（memory-v2）' },
    { key: 'vision', label: '视觉描述', desc: '图片/贴纸描述（vision-processor）' },
  ];

  $: if ($activeTab === 'config') loadConfigData();

  async function loadConfigData() {
    loading = true;
    try {
      config = await api('/config');
      // Ensure defaults for optional sections
      if (!config.contextBudget) config.contextBudget = {};
      if (!config.vision) config.vision = {};
      if (!config.dashboard) config.dashboard = {};
      if (!config.subagent) config.subagent = {};
      if (!config.telegram.humanizedDelay) {
        config.telegram.humanizedDelay = { enabled: false, msPerChar: 50, minDelay: 500, maxDelay: 5000 };
      }
      if (!config.reflection.mergeThresholds) {
        config.reflection.mergeThresholds = {};
      }
      if (!config.reflection.tierLimits) {
        config.reflection.tierLimits = {};
      }
    } catch (err) {
      showToast('加载配置失败: ' + err, 'error');
    }
    loading = false;
  }

  async function saveAll() {
    saving = true;
    try {
      const res = await api('/config', { method: 'PUT', body: config });
      if (res.ok) {
        showToast('✅ 配置已保存并即时生效', 'success');
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
    if (!confirm('确定要重启服务吗？\n\n如果没有进程管理器（pm2/systemd），服务将不会自动恢复。')) return;
    try {
      await api('/restart', { method: 'POST' });
      showToast('🔄 服务正在重启...', 'success');
    } catch {
      showToast('发送重启信号失败', 'error');
    }
  }

  function showToast(msg, type = 'info') {
    toast = { msg, type };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; }, type === 'error' ? 8000 : 4000);
  }

  function addProfile() {
    if (!newProfileName.trim()) return;
    if (config.llmProfiles[newProfileName]) {
      showToast('该 Profile 名称已存在', 'error');
      return;
    }
    config.llmProfiles[newProfileName] = {
      provider: 'openai', baseUrl: '', apiKey: '', model: '',
      temperature: 0.7, maxTokens: 8192,
    };
    config = config;
    newProfileName = '';
    showNewProfile = false;
  }

  function deleteProfile(name) {
    if (!confirm(`确定删除 Profile "${name}"？\n关联的路由配置也会失效。`)) return;
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

  function getProfileNames() {
    return config ? Object.keys(config.llmProfiles) : [];
  }

  // Routing helpers — ensure routing value is always an array for multi-select
  function getRoutingArray(key) {
    const v = config.llmRouting[key];
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }

  function setRoutingArray(key, arr) {
    config.llmRouting[key] = arr.length === 0 ? undefined : arr.length === 1 ? arr[0] : arr;
    config = config;
  }

  function toggleRouting(compKey, profileName) {
    const arr = getRoutingArray(compKey);
    const idx = arr.indexOf(profileName);
    if (idx >= 0) {
      arr.splice(idx, 1);
    } else {
      arr.push(profileName);
    }
    setRoutingArray(compKey, arr);
  }

  function toggle(section) {
    expanded[section] = !expanded[section];
  }
</script>

{#if loading || !config}
  <div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>
{:else}
  <div class="config-editor space-y-3">

    <!-- ════════ LLM Profiles ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.llmProfiles} on:change={() => toggle('llmProfiles')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> LLM Profiles
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-3">定义多个 LLM 配置 profile（provider/key/model），在 Routing 中引用。修改后即时生效。</p>

        {#each Object.entries(config.llmProfiles) as [name, p]}
          <div class="card bg-base-200 mb-3">
            <div class="card-body p-3">
              <div class="flex justify-between items-center mb-2">
                <h4 class="font-mono font-bold text-sm">{name}</h4>
                <div class="flex gap-1">
                  <button class="btn btn-xs btn-outline btn-info" on:click={() => testProfile(name)}
                    disabled={profileTests[name]?.testing}>
                    {profileTests[name]?.testing ? '测试中...' : '🔌 测试连通性'}
                  </button>
                  <button class="btn btn-xs btn-outline btn-error" on:click={() => deleteProfile(name)}>✕</button>
                </div>
              </div>
              {#if profileTests[name] && !profileTests[name].testing}
                <div class="alert alert-sm mb-2 py-1" class:alert-success={profileTests[name].ok} class:alert-error={!profileTests[name].ok}>
                  <span class="text-xs">
                    {profileTests[name].ok
                      ? `✅ 连接成功 (${profileTests[name].latency}ms, model: ${profileTests[name].model || '?'})`
                      : `❌ 失败: ${profileTests[name].error || `HTTP ${profileTests[name].status}`}`}
                  </span>
                </div>
              {/if}
              <div class="grid grid-cols-2 gap-2">
                <label class="form-control">
                  <div class="label py-0"><span class="label-text text-xs">Provider</span></div>
                  <select class="select select-xs select-bordered" bind:value={p.provider}>
                    <option value="openai">openai (OpenAI 兼容)</option>
                    <option value="anthropic">anthropic</option>
                  </select>
                </label>
                <label class="form-control">
                  <div class="label py-0"><span class="label-text text-xs">Model</span></div>
                  <input type="text" class="input input-xs input-bordered" bind:value={p.model} placeholder="gpt-4o" />
                </label>
                <label class="form-control col-span-2">
                  <div class="label py-0"><span class="label-text text-xs">Base URL</span></div>
                  <input type="text" class="input input-xs input-bordered" bind:value={p.baseUrl} placeholder="https://api.openai.com/v1" />
                </label>
                <label class="form-control col-span-2">
                  <div class="label py-0"><span class="label-text text-xs">API Key</span></div>
                  <input type="password" class="input input-xs input-bordered" bind:value={p.apiKey} placeholder="sk-..." />
                </label>
                <label class="form-control">
                  <div class="label py-0"><span class="label-text text-xs">Temperature (0-2)</span></div>
                  <input type="number" class="input input-xs input-bordered" bind:value={p.temperature} min="0" max="2" step="0.1" />
                </label>
                <label class="form-control">
                  <div class="label py-0"><span class="label-text text-xs">Max Tokens</span></div>
                  <input type="number" class="input input-xs input-bordered" bind:value={p.maxTokens} min="1" />
                </label>
                <label class="form-control">
                  <div class="label py-0"><span class="label-text text-xs">Max Context Tokens</span></div>
                  <input type="number" class="input input-xs input-bordered" bind:value={p.maxContextTokens} placeholder="未设置则用全局默认" />
                </label>
                <label class="form-control">
                  <div class="label py-0"><span class="label-text text-xs">Thinking Level</span></div>
                  <select class="select select-xs select-bordered" bind:value={p.thinkingLevel}>
                    <option value={undefined}>无</option>
                    <option value="none">none</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="checkbox checkbox-xs" bind:checked={p.vision} />
                  <span class="text-xs">Vision (多模态)</span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="checkbox checkbox-xs" checked={p.supportsPrefill !== false}
                    on:change={(e) => { p.supportsPrefill = e.target.checked ? undefined : false; config = config; }} />
                  <span class="text-xs">Supports Prefill</span>
                </label>
              </div>
            </div>
          </div>
        {/each}

        <div class="flex items-center gap-2">
          {#if showNewProfile}
            <input type="text" class="input input-xs input-bordered" bind:value={newProfileName} placeholder="新 Profile 名称"
              on:keydown={(e) => e.key === 'Enter' && addProfile()} />
            <button class="btn btn-xs btn-primary" on:click={addProfile}>添加</button>
            <button class="btn btn-xs" on:click={() => showNewProfile = false}>取消</button>
          {:else}
            <button class="btn btn-xs btn-outline btn-primary" on:click={() => showNewProfile = true}>+ 新建 Profile</button>
          {/if}
        </div>
      </div>
    </div>

    <!-- ════════ LLM Routing ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.llmRouting} on:change={() => toggle('llmRouting')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> LLM Routing (组件级路由)
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-3">为每个组件选择 LLM profile。支持多选（fallback chain），第一个失败时自动切换到下一个。</p>
        <div class="space-y-2">
          {#each ROUTING_COMPONENTS as comp}
            <div class="bg-base-200 rounded-lg p-2">
              <div class="flex justify-between items-start mb-1">
                <div>
                  <span class="font-mono text-xs font-semibold">{comp.key}</span>
                  <span class="text-xs opacity-60 ml-1">— {comp.desc}</span>
                </div>
              </div>
              <div class="flex flex-wrap gap-1">
                {#each getProfileNames() as pn}
                  {@const active = getRoutingArray(comp.key).includes(pn)}
                  {@const order = getRoutingArray(comp.key).indexOf(pn)}
                  <button class="btn btn-xs" class:btn-primary={active} class:btn-outline={!active}
                    on:click={() => toggleRouting(comp.key, pn)}>
                    {#if active && order >= 0}<span class="badge badge-xs mr-1">{order + 1}</span>{/if}
                    {pn}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- ════════ Persona ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.persona} on:change={() => toggle('persona')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> 人格设置
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">Agent 的名字和人格描述。注入到所有 LLM system prompt 中。</p>
        <label class="form-control mb-2">
          <div class="label py-0"><span class="label-text text-xs">Agent 名字</span></div>
          <input type="text" class="input input-sm input-bordered" bind:value={config.persona.name} />
        </label>
        <label class="form-control">
          <div class="label py-0"><span class="label-text text-xs">人格描述</span></div>
          <textarea class="textarea textarea-bordered textarea-sm" rows="4" bind:value={config.persona.description}></textarea>
        </label>
      </div>
    </div>

    <!-- ════════ Timezone ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.timezone} on:change={() => toggle('timezone')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> 全局时区
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">影响 LLM prompt 中的时间展示和作息判断。使用 IANA 标识符。</p>
        <input type="text" class="input input-sm input-bordered w-full" bind:value={config.timezone}
          placeholder="Asia/Shanghai" list="tz-list" />
        <datalist id="tz-list">
          <option value="Asia/Shanghai">Asia/Shanghai (UTC+8)</option>
          <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
          <option value="America/New_York">America/New_York (EST)</option>
          <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
          <option value="Europe/London">Europe/London (GMT)</option>
          <option value="Europe/Berlin">Europe/Berlin (CET)</option>
          <option value="UTC">UTC</option>
        </datalist>
      </div>
    </div>

    <!-- ════════ Notification ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.notification} on:change={() => toggle('notification')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> 通知唤醒
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">文本包含这些关键词时，立即触发 Main Agent 处理（@提及/名字唤醒）。</p>
        <div class="flex flex-wrap gap-1 mb-2">
          {#each config.notification.mentionKeywords as kw}
            <div class="badge badge-outline gap-1">
              {kw}
              <button class="btn btn-ghost btn-xs px-0" on:click={() => removeKeyword(kw)}>✕</button>
            </div>
          {/each}
        </div>
        <div class="flex gap-1">
          <input type="text" class="input input-xs input-bordered flex-1" bind:value={newKeyword}
            placeholder="添加关键词..." on:keydown={(e) => e.key === 'Enter' && addKeyword()} />
          <button class="btn btn-xs btn-primary" on:click={addKeyword}>添加</button>
        </div>
      </div>
    </div>

    <!-- ════════ Telegram ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.telegram} on:change={() => toggle('telegram')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-warning badge-sm">⚠️ 部分需重启</span> Telegram 设置
      </div>
      <div class="collapse-content">
        <div class="alert alert-warning py-1 mb-3"><span class="text-xs">⚠️ 连接参数（mode/botToken/apiId/apiHash/phone）修改后需要重启服务才能生效。</span></div>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">连接模式</span></div>
            <select class="select select-xs select-bordered" bind:value={config.telegram.mode}>
              <option value="bot">bot</option>
              <option value="userbot">userbot</option>
            </select>
          </label>
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Bot Token</span></div>
            <input type="password" class="input input-xs input-bordered" bind:value={config.telegram.botToken} />
          </label>
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">API ID</span></div>
            <input type="text" class="input input-xs input-bordered" bind:value={config.telegram.apiId} />
          </label>
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">API Hash</span></div>
            <input type="password" class="input input-xs input-bordered" bind:value={config.telegram.apiHash} />
          </label>
          <label class="form-control col-span-2">
            <div class="label py-0"><span class="label-text text-xs">手机号 (userbot 模式)</span></div>
            <input type="text" class="input input-xs input-bordered" bind:value={config.telegram.phone} placeholder="+86..." />
          </label>
        </div>
        <!-- Humanized Delay -->
        <div class="divider text-xs opacity-60 my-2">拟人化发送延迟 <span class="badge badge-primary badge-xs">✅ 即时</span></div>
        <label class="flex items-center gap-2 cursor-pointer mb-2">
          <input type="checkbox" class="toggle toggle-xs" bind:checked={config.telegram.humanizedDelay.enabled} />
          <span class="text-xs">启用拟人化延迟</span>
        </label>
        {#if config.telegram.humanizedDelay.enabled}
          <div class="grid grid-cols-3 gap-2">
            <label class="form-control">
              <div class="label py-0"><span class="label-text text-xs">每字符 ms</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.telegram.humanizedDelay.msPerChar} />
            </label>
            <label class="form-control">
              <div class="label py-0"><span class="label-text text-xs">最小延迟 ms</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.telegram.humanizedDelay.minDelay} />
            </label>
            <label class="form-control">
              <div class="label py-0"><span class="label-text text-xs">最大延迟 ms</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.telegram.humanizedDelay.maxDelay} />
            </label>
          </div>
        {/if}
      </div>
    </div>

    <!-- ════════ Reflection ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.reflection} on:change={() => toggle('reflection')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> Reflection 反思设置
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">控制反思引擎的行为参数：冷场/定时/作息触发条件，渐进合并阈值。</p>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Profile</span></div>
            <select class="select select-xs select-bordered" bind:value={config.reflection.profile}>
              <option value={undefined}>（跟随 routing）</option>
              {#each getProfileNames() as pn}<option value={pn}>{pn}</option>{/each}
            </select>
          </label>
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">冷场阈值 (秒)</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.reflection.silenceThreshold} placeholder="7200" />
          </label>
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">最大间隔 (秒)</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.reflection.maxInterval} placeholder="86400" />
          </label>
          <label class="form-control">
            <div class="label py-0"><span class="label-text text-xs">检查间隔 (秒)</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.reflection.checkInterval} placeholder="300" />
          </label>
        </div>
        <!-- Merge Thresholds -->
        <div class="divider text-xs opacity-60 my-2">渐进合并阈值 (天)</div>
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
        <!-- Awake Hours -->
        <div class="divider text-xs opacity-60 my-2">作息时间</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">起始小时 (24h)</span></div>
            <input type="number" class="input input-xs input-bordered"
              value={config.reflection.awakeHours?.[0] ?? ''}
              on:input={(e) => { if (!config.reflection.awakeHours) config.reflection.awakeHours = [8, 24]; config.reflection.awakeHours[0] = Number(e.target.value); config = config; }} placeholder="8" min="0" max="23" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">结束小时 (24h)</span></div>
            <input type="number" class="input input-xs input-bordered"
              value={config.reflection.awakeHours?.[1] ?? ''}
              on:input={(e) => { if (!config.reflection.awakeHours) config.reflection.awakeHours = [8, 24]; config.reflection.awakeHours[1] = Number(e.target.value); config = config; }} placeholder="24" min="0" max="24" /></label>
        </div>
      </div>
    </div>

    <!-- ════════ Context Budget ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.contextBudget} on:change={() => toggle('contextBudget')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> Context Budget (上下文预算)
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">控制上下文压缩的 token 预算分配。留空使用默认值。</p>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">有效上下文窗口 (tokens)</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.contextBudget.effectiveContextWindow} placeholder="32000" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">System Prompt 比例</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.contextBudget.systemPromptRatio} placeholder="0.20" step="0.05" min="0" max="1" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Briefing 比例</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.contextBudget.briefingRatio} placeholder="0.15" step="0.05" min="0" max="1" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">近期消息比例</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.contextBudget.recentHistoryRatio} placeholder="0.50" step="0.05" min="0" max="1" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">输出预留 (tokens)</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.contextBudget.outputReserve} placeholder="4096" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">最少保留消息</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.contextBudget.minRecentMessages} placeholder="6" /></label>
          <label class="form-control col-span-2"><div class="label py-0"><span class="label-text text-xs">Briefing 最大 tokens</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.contextBudget.maxBriefingTokens} placeholder="3000" /></label>
        </div>
      </div>
    </div>

    <!-- ════════ Embedding ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.embedding} on:change={() => toggle('embedding')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-error badge-sm">🚫 需重启</span> Embedding 向量化
      </div>
      <div class="collapse-content">
        <div class="alert alert-warning py-1 mb-3"><span class="text-xs">⚠️ 切换 provider/dimensions 后已有向量数据将不兼容，需要重启服务。</span></div>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Provider</span></div>
            <select class="select select-xs select-bordered" bind:value={config.embedding.provider}>
              <option value="local">local (本地 hash)</option>
              <option value="openai">openai (API)</option>
            </select></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">相似度度量</span></div>
            <select class="select select-xs select-bordered" bind:value={config.embedding.similarityMetric}>
              <option value="cosine">cosine</option>
              <option value="dot_product">dot_product</option>
              <option value="euclidean">euclidean</option>
              <option value="manhattan">manhattan</option>
            </select></label>
          {#if config.embedding.provider === 'openai'}
            <label class="form-control col-span-2"><div class="label py-0"><span class="label-text text-xs">Base URL</span></div>
              <input type="text" class="input input-xs input-bordered" bind:value={config.embedding.baseUrl} /></label>
            <label class="form-control col-span-2"><div class="label py-0"><span class="label-text text-xs">API Key</span></div>
              <input type="password" class="input input-xs input-bordered" bind:value={config.embedding.apiKey} /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Model</span></div>
              <input type="text" class="input input-xs input-bordered" bind:value={config.embedding.model} /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Dimensions</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.embedding.dimensions} /></label>
          {/if}
        </div>
      </div>
    </div>

    <!-- ════════ Vision ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.vision} on:change={() => toggle('vision')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-primary badge-sm">✅ 即时</span> Vision 看图设置
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">控制图片和贴纸的处理行为。需配合 vision profile 使用。</p>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">压缩阈值 (px)</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.vision.maxImageSize} placeholder="1024" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">单轮最大内联图片</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.vision.maxImagesPerContext} placeholder="3" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Sticker 处理模式</span></div>
            <select class="select select-xs select-bordered" bind:value={config.vision.stickerMode}>
              <option value={undefined}>（默认 emoji_only）</option>
              <option value="emoji_only">emoji_only — 仅 emoji</option>
              <option value="vision_cache">vision_cache — 缓存描述</option>
              <option value="vision_each">vision_each — 每次识别</option>
            </select></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">下载大小上限 (MB)</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.vision.maxMediaDownloadSize} placeholder="20" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">媒体保留天数</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.vision.mediaRetentionDays} placeholder="3" /></label>
        </div>
      </div>
    </div>

    <!-- ════════ Dashboard ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.dashboard} on:change={() => toggle('dashboard')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-error badge-sm">🚫 需重启</span> Dashboard 设置
      </div>
      <div class="collapse-content">
        <div class="alert alert-warning py-1 mb-3"><span class="text-xs">⚠️ 端口和 Token 修改后需要重启服务才能生效。</span></div>
        <div class="grid grid-cols-3 gap-2">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="toggle toggle-xs" bind:checked={config.dashboard.enabled} />
            <span class="text-xs">启用</span>
          </label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">端口</span></div>
            <input type="number" class="input input-xs input-bordered" bind:value={config.dashboard.port} placeholder="6767" /></label>
          <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Token</span></div>
            <input type="password" class="input input-xs input-bordered" bind:value={config.dashboard.token} /></label>
        </div>
      </div>
    </div>

    <!-- ════════ Subagent / CodeAct ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.subagent} on:change={() => toggle('subagent')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-warning badge-sm">⚠️ 部分需重启</span> Subagent / CodeAct
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">控制 CodeAct 交互引擎和 Subagent 系统的行为参数。</p>
        {#if config.subagent}
          <div class="grid grid-cols-2 gap-2">
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">最大 Sandbox 实例</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.subagent.maxSandboxInstances} placeholder="5" /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Sandbox 空闲超时 (ms)</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.subagent.sandboxIdleTimeout} placeholder="600000" /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">轮询间隔 (ms)</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.subagent.pollInterval} placeholder="5000" /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Alert Engagement 阈值</span></div>
              <input type="number" class="input input-xs input-bordered" bind:value={config.subagent.alertEngagementThreshold} placeholder="60" /></label>
          </div>
          <!-- CodeAct sub-section -->
          <div class="divider text-xs opacity-60 my-2">CodeAct</div>
          <div class="grid grid-cols-3 gap-2">
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">最大轮次</span></div>
              <input type="number" class="input input-xs input-bordered" value={config.subagent.codeAct?.maxTurns ?? ''}
                on:input={(e) => { if (!config.subagent.codeAct) config.subagent.codeAct = {}; config.subagent.codeAct.maxTurns = Number(e.target.value) || undefined; config = config; }} placeholder="30" /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">执行超时 (ms)</span></div>
              <input type="number" class="input input-xs input-bordered" value={config.subagent.codeAct?.maxExecutionTimeMs ?? ''}
                on:input={(e) => { if (!config.subagent.codeAct) config.subagent.codeAct = {}; config.subagent.codeAct.maxExecutionTimeMs = Number(e.target.value) || undefined; config = config; }} placeholder="60000" /></label>
            <label class="form-control"><div class="label py-0"><span class="label-text text-xs">Session 最大消息</span></div>
              <input type="number" class="input input-xs input-bordered" value={config.subagent.codeAct?.maxSessionMessages ?? ''}
                on:input={(e) => { if (!config.subagent.codeAct) config.subagent.codeAct = {}; config.subagent.codeAct.maxSessionMessages = Number(e.target.value) || undefined; config = config; }} placeholder="100" /></label>
          </div>
        {/if}
      </div>
    </div>

    <!-- ════════ Tavily ════════ -->
    <div class="collapse collapse-arrow bg-base-100 border border-base-300">
      <input type="checkbox" checked={expanded.tavily} on:change={() => toggle('tavily')} />
      <div class="collapse-title font-semibold text-sm flex items-center gap-2">
        <span class="badge badge-warning badge-sm">⚠️ 需重启</span> Tavily 网络搜索
      </div>
      <div class="collapse-content">
        <p class="text-xs opacity-60 mb-2">Tavily Search API key，用于 subagent 的联网搜索能力。</p>
        <label class="form-control">
          <input type="password" class="input input-sm input-bordered" bind:value={config.tavilyApiKey} placeholder="tvly-your-api-key" />
        </label>
      </div>
    </div>

  </div>

  <!-- ════════ Bottom Action Bar ════════ -->
  <div class="config-action-bar">
    <button class="btn btn-primary btn-sm" on:click={saveAll} disabled={saving}>
      {saving ? '保存中...' : '💾 保存配置'}
    </button>
    <button class="btn btn-ghost btn-sm" on:click={loadConfigData}>🔄 重置</button>
    <div class="flex-1"></div>
    <button class="btn btn-error btn-sm btn-outline" on:click={restartService}>🔁 重启服务</button>
  </div>

  <!-- Toast -->
  {#if toast}
    <div class="toast toast-top toast-center z-50">
      <div class="alert py-2 px-4 shadow-lg" class:alert-success={toast.type === 'success'} class:alert-error={toast.type === 'error'} class:alert-info={toast.type === 'info'}>
        <span class="text-sm whitespace-pre-wrap">{toast.msg}</span>
      </div>
    </div>
  {/if}
{/if}

<style>
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
    backdrop-filter: blur(12px);
  }
  .config-editor :global(.collapse-title) {
    min-height: 2.5rem;
    padding: 0.5rem 1rem;
  }
  .config-editor :global(.collapse-content) {
    padding-top: 0;
  }
</style>
