<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';

  let status = null;
  let loading = true;
  let triggering = false;
  let sinceMode = 'default'; // default | 6h | 24h | 3d | all | custom
  let customSince = '';      // datetime-local 值（本地时区）
  let selectedRunId = null;
  let autoScroll = true;
  let logEl;
  let allRuns = [];
  let selectedRun = null;
  let selectedEvents = [];
  let selectedEventsRunId = null;
  let eventLogSource = 'memory';
  let visibleEvents = [];

  $: allRuns = status?.enabled
    ? [status.currentRun, ...(status.runs ?? [])].filter(Boolean)
    : [];

  $: if (allRuns.length && !allRuns.some(run => run.id === selectedRunId)) {
    selectedRunId = allRuns[0].id;
  }

  $: selectedRun = allRuns.find(run => run.id === selectedRunId) ?? allRuns[0] ?? null;
  $: visibleEvents = selectedEventsRunId === selectedRun?.id && selectedEvents.length
    ? selectedEvents
    : selectedRun?.events ?? [];

  // 把原始 wrapper 事件解析成对用户友好的渲染段落，过滤掉流式碎片。
  $: feed = visibleEvents
    .map((event) => ({ event, segments: buildSegments(event).map(decorate) }))
    .filter((item) => item.segments.length);

  // 只有在贴着底部（autoScroll）时才跟随新内容滚动；用户往上滚会自动取消。
  $: if (autoScroll && feed && logEl) scrollToBottomSoon();

  async function refresh() {
    try {
      const next = await api('/background-agent');
      status = next;
      const runId = selectedRunId ?? next.currentRun?.id ?? next.runs?.[0]?.id;
      if (!selectedRunId && runId) selectedRunId = runId;
      if (runId) await loadRunEvents(runId, selectedEventsRunId === runId);
    } catch (e) {
      status = { enabled: false, error: String(e) };
    }
    loading = false;
  }

  // 把收集起点选项转换成发给后端的 since 值（undefined=默认/沿用上次做梦起点）
  function resolveSince() {
    const now = Date.now();
    switch (sinceMode) {
      case '6h': return new Date(now - 6 * 3600e3).toISOString();
      case '24h': return new Date(now - 24 * 3600e3).toISOString();
      case '3d': return new Date(now - 3 * 24 * 3600e3).toISOString();
      case 'all': return 'all';
      case 'custom': {
        if (!customSince) return undefined;
        const ms = new Date(customSince).getTime();
        return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
      }
      default: return undefined;
    }
  }

  async function trigger() {
    if (sinceMode === 'custom' && !customSince) {
      alert('请选择自定义开始时间');
      return;
    }
    triggering = true;
    try {
      const since = resolveSince();
      await api('/background-agent/trigger', {
        method: 'POST',
        ...(since === undefined ? {} : { body: { since } }),
      });
      await refresh();
    } catch (e) {
      alert('Trigger failed: ' + e);
    } finally {
      triggering = false;
    }
  }

  function selectRun(run) {
    selectedRunId = run.id;
    selectedEvents = run.events ?? [];
    selectedEventsRunId = run.id;
    eventLogSource = 'memory';
    void loadRunEvents(run.id, false);
  }

  async function loadRunEvents(runId, append) {
    if (!runId) return;
    try {
      const lastId = append && selectedEventsRunId === runId && selectedEvents.length
        ? selectedEvents[selectedEvents.length - 1].id
        : null;
      const suffix = lastId != null ? `?after=${encodeURIComponent(lastId)}` : '';
      const result = await api(`/background-agent/runs/${encodeURIComponent(runId)}/events${suffix}`);
      const events = result.events ?? [];
      selectedEventsRunId = runId;
      eventLogSource = result.source ?? 'memory';
      selectedEvents = append && lastId != null
        ? [...selectedEvents, ...events]
        : events;
    } catch {
      const fallback = allRuns.find(run => run.id === runId);
      selectedEventsRunId = runId;
      selectedEvents = fallback?.events ?? [];
      eventLogSource = 'memory';
    }
  }

  function formatDate(ts) {
    return ts ? new Date(ts).toLocaleString() : '-';
  }

  function formatTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString() : '-';
  }

  function formatDuration(run) {
    if (!run?.startedAt) return '-';
    const end = run.endedAt ?? Date.now();
    return `${((end - run.startedAt) / 1000).toFixed(1)}s`;
  }

  function exitBadge(run) {
    if (!run?.endedAt) return '运行中';
    if (run.exitCode === 0) return '完成';
    return `退出 ${run.exitCode ?? '?'}`;
  }

  function eventJson(event) {
    return event.event ? JSON.stringify(event.event, null, 2) : '';
  }

  // ----- 自动滚动 -----
  function nearBottom() {
    if (!logEl) return true;
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  }

  function onLogScroll() {
    // 用户手动滚动时更新「是否贴底」状态：滚上去就取消跟随，滚回底部就恢复。
    autoScroll = nearBottom();
  }

  function scrollToBottomSoon() {
    setTimeout(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }, 0);
  }

  function toggleAutoScroll(event) {
    autoScroll = event.currentTarget.checked;
    if (autoScroll) scrollToBottomSoon();
  }

  // ----- 事件解析（按 harness 格式渲染） -----
  const KIND_META = {
    thinking: { icon: '💭', label: '思考', tone: 'thinking' },
    assistant: { icon: '💬', label: '回复', tone: 'assistant' },
    user: { icon: '🧑', label: '输入', tone: 'user' },
    tool_use: { icon: '🔧', label: '调用工具', tone: 'tool' },
    tool_result: { icon: '📦', label: '工具结果', tone: 'tool' },
    system: { icon: '⚙️', label: '系统', tone: 'system' },
    session: { icon: '🔌', label: '会话', tone: 'meta' },
    result: { icon: '🏁', label: '结果', tone: 'success' },
    meta: { icon: 'ℹ️', label: '信息', tone: 'meta' },
    error: { icon: '⛔', label: '错误', tone: 'error' },
    raw: { icon: '📄', label: '原始', tone: 'normal' },
  };

  // 流式碎片 / 纯噪声事件，不进入友好视图（仍可在 JSONL 原文里看到）。
  const NOISE = new Set([
    'assistant.reasoning_delta',
    'assistant.message_delta',
    'assistant.message_start',
    'assistant.turn_start',
    'assistant.turn_end',
    'session.background_tasks_changed',
    'system/thinking_tokens',
    'thinking_tokens',
  ]);

  const SYS_LABELS = {
    launch: '启动', home: '环境', spawn: '进程', exit: '退出', text: '输出', stderr: 'stderr',
  };

  function toArray(value) {
    return Array.isArray(value) ? value : value == null ? [] : [value];
  }

  function stringifyContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? JSON.stringify(part)))
        .join('\n');
    }
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }

  function formatArgs(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    let text;
    try {
      text = JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
    return text === '{}' || text === '[]' ? '' : text;
  }

  // 处理超长事件被后端裁剪成 { type, truncated, preview } 的情况。
  function effectiveEvent(raw) {
    if (raw && raw.truncated && typeof raw.preview === 'string') {
      try {
        const parsed = JSON.parse(raw.preview);
        parsed.__truncated = true;
        return parsed;
      } catch {
        return { type: raw.type, __truncatedRaw: true, preview: raw.preview };
      }
    }
    return raw;
  }

  function decorate(seg) {
    const meta = KIND_META[seg.kind] ?? KIND_META.raw;
    let { icon, tone } = meta;
    let label = seg.label ?? meta.label;
    if (seg.kind === 'tool_use' && seg.tool?.name) label = `调用 ${seg.tool.name}`;
    if (seg.kind === 'tool_result') {
      if (seg.tool?.ok === false) {
        icon = '❌';
        tone = 'error';
        label = seg.tool?.name ? `${seg.tool.name} 失败` : '工具失败';
      } else {
        icon = '✅';
        tone = 'success';
        label = seg.tool?.name ? `${seg.tool.name} 结果` : '工具结果';
      }
    }
    return { ...seg, icon, tone, label };
  }

  function buildSegments(wrapper) {
    try {
      return _buildSegments(wrapper);
    } catch {
      return [{ kind: 'raw', text: wrapper.text ?? '' }];
    }
  }

  function _buildSegments(wrapper) {
    const raw = wrapper.event;
    if (!raw || typeof raw !== 'object') return systemSegments(wrapper);

    const ev = effectiveEvent(raw);
    const type = String(ev.type ?? wrapper.kind ?? '');
    const subtype = ev.subtype == null ? '' : String(ev.subtype);
    if (NOISE.has(type) || (subtype && (NOISE.has(subtype) || NOISE.has(`${type}/${subtype}`)))) return [];

    // Codex CLI (`codex exec --json`)
    if (type === 'error') return [{ kind: 'error', text: stringifyContent(ev.message ?? ev.error ?? ev) }];
    if (type.startsWith('thread.') || type.startsWith('turn.')) return [codexLifecycle(ev, type)];
    if (type.startsWith('item.')) return codexItem(ev, type);

    // Claude Code (stream-json)
    if (type === 'assistant') return claudeAssistant(ev);
    if (type === 'user') return claudeUser(ev);
    if (type === 'system') return [claudeSystem(ev)];
    if (type === 'rate_limit_event') return [rateLimitSeg(ev)];
    if (type === 'result') return [resultSeg(ev)];

    // Copilot CLI (json events)
    if (type === 'user.message') return [{ kind: 'user', text: ev.__truncatedRaw ? ev.preview : (ev?.data?.content ?? '') }];
    if (type === 'assistant.reasoning') return [{ kind: 'thinking', text: ev?.data?.content ?? '' }];
    if (type === 'assistant.message') return copilotAssistant(ev);
    if (type === 'tool.execution_start') return [copilotToolStart(ev)];
    if (type === 'tool.execution_complete') return [copilotToolComplete(ev)];
    if (type.startsWith('session.')) return [copilotSession(ev, type)];
    if (type.startsWith('assistant.')) return []; // 其余 assistant.* 为流式噪声

    return [{ kind: 'raw', label: type || wrapper.kind, text: wrapper.text ?? stringifyContent(ev) }];
  }

  function systemSegments(wrapper) {
    if (wrapper.stream === 'stderr' || wrapper.kind === 'failure') {
      return [{ kind: 'error', label: wrapper.kind === 'failure' ? '启动失败' : 'stderr', text: wrapper.text ?? '' }];
    }
    return [{ kind: 'system', label: SYS_LABELS[wrapper.kind] ?? wrapper.kind, text: wrapper.text ?? '' }];
  }

  function claudeAssistant(ev) {
    const content = ev?.message?.content;
    const model = ev?.message?.model;
    const segs = [];
    if (typeof content === 'string') {
      if (content.trim()) segs.push({ kind: 'assistant', text: content, model });
      return segs;
    }
    for (const block of toArray(content)) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking') segs.push({ kind: 'thinking', text: block.thinking ?? '' });
      else if (block.type === 'text') segs.push({ kind: 'assistant', text: block.text ?? '', model });
      else if (block.type === 'tool_use') segs.push({ kind: 'tool_use', tool: { name: block.name, input: block.input } });
    }
    return segs;
  }

  function claudeUser(ev) {
    const content = ev?.message?.content;
    if (typeof content === 'string') return [{ kind: 'user', text: content }];
    const segs = [];
    for (const block of toArray(content)) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        segs.push({ kind: 'tool_result', tool: { ok: !block.is_error, output: stringifyContent(block.content) } });
      } else if (block.type === 'text') {
        segs.push({ kind: 'user', text: block.text ?? '' });
      }
    }
    return segs.length ? segs : [{ kind: 'user', text: stringifyContent(content) }];
  }

  function claudeSystem(ev) {
    const chips = [];
    if (ev.model) chips.push({ k: '模型', v: ev.model });
    if (Array.isArray(ev.tools)) chips.push({ k: '工具', v: `${ev.tools.length} 个` });
    const mcp = ev.mcp_servers;
    if (Array.isArray(mcp) && mcp.length) chips.push({ k: 'MCP', v: mcp.map((s) => s?.name ?? s).join(', ') });
    if (ev.cwd) chips.push({ k: '目录', v: ev.cwd });
    return { kind: 'system', label: `会话初始化${ev.subtype ? ` · ${ev.subtype}` : ''}`, chips };
  }

  function rateLimitSeg(ev) {
    const info = ev.rate_limit_info ?? {};
    const chips = [
      { k: '状态', v: info.status },
      { k: '类型', v: info.rateLimitType },
    ].filter((c) => c.v != null);
    return { kind: 'meta', label: '限流状态', chips };
  }

  function resultSeg(ev) {
    const chips = [];
    const dur = ev.duration_ms ?? ev?.usage?.sessionDurationMs;
    if (dur != null) chips.push({ k: '耗时', v: `${(Number(dur) / 1000).toFixed(1)}s` });
    if (ev.num_turns != null) chips.push({ k: '回合', v: ev.num_turns });
    const cost = ev.total_cost_usd ?? ev.cost_usd;
    if (cost != null) chips.push({ k: '花费', v: `$${Number(cost).toFixed(4)}` });
    if (ev?.usage?.premiumRequests != null) chips.push({ k: 'Premium', v: ev.usage.premiumRequests });
    if (ev.exitCode != null) chips.push({ k: '退出码', v: ev.exitCode });
    const cc = ev?.usage?.codeChanges;
    if (cc && (cc.linesAdded || cc.linesRemoved)) chips.push({ k: '改动', v: `+${cc.linesAdded ?? 0}/-${cc.linesRemoved ?? 0}` });
    return { kind: 'result', label: '运行结果', text: typeof ev.result === 'string' ? ev.result : '', chips };
  }

  function codexLifecycle(ev, type) {
    if (type === 'thread.started') {
      return { kind: 'session', label: 'Codex 会话', chips: [{ k: 'Thread', v: ev.thread_id }] };
    }
    if (type === 'turn.started') return { kind: 'session', label: 'Codex 回合开始' };
    if (type === 'turn.failed') {
      return { kind: 'error', label: 'Codex 回合失败', text: stringifyContent(ev.error ?? ev.message ?? '') };
    }
    if (type === 'turn.completed') {
      const usage = ev.usage ?? {};
      const chips = [
        { k: '输入', v: usage.input_tokens },
        { k: '缓存', v: usage.cached_input_tokens },
        { k: '输出', v: usage.output_tokens },
        { k: '推理', v: usage.reasoning_output_tokens },
      ].filter((c) => c.v != null);
      return { kind: 'result', label: 'Codex 回合完成', chips };
    }
    return { kind: 'session', label: type.replace('.', ' · ') };
  }

  function codexItem(ev, type) {
    const item = ev.item ?? {};
    const completed = type === 'item.completed';
    if (item.type === 'agent_message') {
      return completed && item.text ? [{ kind: 'assistant', text: item.text }] : [];
    }
    if (item.type === 'reasoning') {
      return completed && item.text ? [{ kind: 'thinking', text: item.text }] : [];
    }
    if (item.type === 'command_execution') {
      if (!completed) {
        return type === 'item.started'
          ? [{ kind: 'tool_use', tool: { name: 'shell', input: item.command } }]
          : [];
      }
      return [{
        kind: 'tool_result',
        tool: {
          name: 'shell',
          ok: item.status === 'completed' && (item.exit_code == null || item.exit_code === 0),
          output: stringifyContent(item.aggregated_output ?? item.output ?? ''),
        },
      }];
    }
    if (item.type === 'mcp_tool_call') {
      const name = [item.server, item.tool].filter(Boolean).join('.') || 'mcp';
      if (!completed) {
        return type === 'item.started'
          ? [{ kind: 'tool_use', tool: { name, input: item.arguments } }]
          : [];
      }
      return [{
        kind: 'tool_result',
        tool: {
          name,
          ok: item.status === 'completed' && !item.error,
          output: stringifyContent(item.result ?? item.error ?? ''),
        },
      }];
    }
    if (item.type === 'web_search') {
      return completed
        ? [{ kind: 'tool_result', tool: { name: 'web_search', ok: item.status === 'completed', output: stringifyContent(item.result ?? '') } }]
        : type === 'item.started'
          ? [{ kind: 'tool_use', tool: { name: 'web_search', input: item.query } }]
          : [];
    }
    if (item.type === 'file_change' && completed) {
      return [{ kind: 'meta', label: '文件改动', text: stringifyContent(item.changes ?? item) }];
    }
    if (item.type === 'plan_update' && completed) {
      return [{ kind: 'meta', label: '计划更新', text: stringifyContent(item.plan ?? item) }];
    }
    return completed ? [{ kind: 'raw', label: item.type ?? type, text: stringifyContent(item) }] : [];
  }

  function copilotAssistant(ev) {
    const text = ev?.data?.content;
    if (typeof text === 'string' && text.trim()) {
      return [{ kind: 'assistant', text, model: ev?.data?.model }];
    }
    return [];
  }

  function copilotToolStart(ev) {
    const d = ev.data ?? {};
    return { kind: 'tool_use', tool: { name: d.toolName, input: d.arguments } };
  }

  function copilotToolComplete(ev) {
    const d = ev.data ?? {};
    const r = d.result ?? {};
    const output = r.detailedContent ?? r.content ?? (typeof r === 'string' ? r : stringifyContent(r));
    return { kind: 'tool_result', tool: { ok: d.success !== false, name: d.toolName, output: stringifyContent(output) } };
  }

  function copilotSession(ev, type) {
    const d = ev.data ?? {};
    if (type === 'session.mcp_servers_loaded') {
      const chips = toArray(d.servers).map((s) => ({ k: '', v: `${s?.name ?? s}（${s?.status ?? '?'}）` }));
      return { kind: 'session', label: 'MCP 服务器', chips };
    }
    if (type === 'session.tools_updated') return { kind: 'session', label: '模型', text: d.model ?? '' };
    if (type === 'session.skills_loaded') return { kind: 'session', label: '技能', text: `${toArray(d.skills).length} 个` };
    if (type === 'session.mcp_server_status_changed') {
      return { kind: 'session', label: 'MCP 状态', text: d.name ? `${d.name}: ${d.status ?? ''}` : stringifyContent(d) };
    }
    return { kind: 'session', label: type.replace('session.', ''), text: '' };
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  });
</script>

<div class="card bg-base-100">
  <div class="card-body p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold">做梦系统</h2>
        <p class="text-sm text-base-content/70">Background Agent harness 输出、动作和结果记录。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-1" title="本周期 subagent 任务的收集起点">
          <span class="text-xs text-base-content/60">收集起点</span>
          <select class="select select-bordered select-sm" bind:value={sinceMode} disabled={!status?.enabled}>
            <option value="default">默认（上次做梦后）</option>
            <option value="6h">最近 6 小时</option>
            <option value="24h">最近 24 小时</option>
            <option value="3d">最近 3 天</option>
            <option value="all">全部留存任务</option>
            <option value="custom">自定义…</option>
          </select>
          {#if sinceMode === 'custom'}
            <input type="datetime-local" class="input input-bordered input-sm" bind:value={customSince} />
          {/if}
        </div>
        <button class="btn btn-primary btn-sm" onclick={trigger} disabled={triggering || !status?.enabled}>
          {triggering ? '触发中...' : '立即做梦'}
        </button>
        <button class="btn btn-ghost btn-sm" onclick={refresh} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>
    </div>

    {#if loading}
      <div class="text-sm text-base-content/60">正在加载做梦系统状态...</div>
    {:else if !status?.enabled}
      <div class="alert">
        <span>Background Agent 未启用。在配置编辑 → 做梦系统中选择一个 Harness 类型（Claude Code、Codex CLI 或 Copilot CLI）。</span>
      </div>
    {:else}
      <div class="stats stats-vertical lg:stats-horizontal shadow-sm bg-base-200">
        <div class="stat py-3">
          <div class="stat-title">状态</div>
          <div class="stat-value text-2xl">{status.running ? 'Running' : 'Idle'}</div>
          <div class="stat-desc">{status.harness ?? 'unknown'}</div>
        </div>
        <div class="stat py-3">
          <div class="stat-title">队列</div>
          <div class="stat-value text-2xl">{status.queueLength}</div>
        </div>
        <div class="stat py-3">
          <div class="stat-title">运行记录</div>
          <div class="stat-value text-2xl">{status.historyCount}</div>
        </div>
        <div class="stat py-3">
          <div class="stat-title">连续失败</div>
          <div class="stat-value text-2xl" class:text-error={status.consecutiveFailures > 0}>{status.consecutiveFailures}</div>
        </div>
      </div>

      {#if status.lastError}
        <div class="alert alert-error">
          <span>{status.lastError}</span>
        </div>
      {/if}

      <div class="grid grid-cols-1 xl:grid-cols-[0.95fr_1.55fr] gap-4">
        <section class="card bg-base-200 shadow-sm">
          <div class="card-body p-4">
            <div class="flex items-center justify-between gap-3 mb-2">
              <h3 class="card-title text-base">运行批次</h3>
              <span class="badge badge-outline">{allRuns.length}</span>
            </div>

            {#if !allRuns.length}
              <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                还没有做梦记录。可以手动触发一次。
              </div>
            {:else}
              <div class="runs space-y-2">
                {#each allRuns as run}
                  <button
                    class="run-item"
                    class:active={selectedRunId === run.id}
                    onclick={() => selectRun(run)}
                    title={run.id}
                  >
                    <div class="run-main">
                      <span class="badge badge-xs shrink-0" class:badge-success={run.exitCode === 0} class:badge-error={run.endedAt && run.exitCode !== 0} class:badge-info={!run.endedAt}>
                        {exitBadge(run)}
                      </span>
                      <span class="font-mono truncate">{run.id}</span>
                    </div>
                    <div class="run-meta">
                      <span>{run.trigger}</span>
                      <span>{formatDate(run.startedAt)}</span>
                      <span>{formatDuration(run)}</span>
                    </div>
                    <div class="run-meta">
                      <span>{run.harness}</span>
                      <span>{run.eventCount ?? run.events?.length ?? 0} events</span>
                      {#if run.costUsd != null}<span>${Number(run.costUsd).toFixed(4)}</span>{/if}
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </section>

        <section class="card bg-base-200 shadow-sm">
          <div class="card-body p-4">
            {#if selectedRun}
              <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div class="min-w-0">
                  <h3 class="card-title text-base">全程记录</h3>
                  <div class="text-xs text-base-content/60 font-mono break-all">{selectedRun.id} · {eventLogSource}</div>
                </div>
                <label class="label cursor-pointer gap-2 py-0">
                  <span class="label-text text-xs">自动滚动</span>
                  <input type="checkbox" class="toggle toggle-xs" checked={autoScroll} onchange={toggleAutoScroll} />
                </label>
              </div>

              <div class="run-summary">
                <div><span>开始</span><strong>{formatDate(selectedRun.startedAt)}</strong></div>
                <div><span>耗时</span><strong>{formatDuration(selectedRun)}</strong></div>
                <div><span>PID</span><strong>{selectedRun.pid ?? '-'}</strong></div>
                <div><span>MCP</span><strong>{(selectedRun.mcpServers ?? []).join(', ') || '-'}</strong></div>
                {#if selectedRun.harnessHome}
                  <div class="col-span-full"><span>用户 HOME</span><strong class="font-mono break-all">{selectedRun.harnessHome}</strong></div>
                {/if}
                {#if selectedRun.instructionPath}
                  <div class="col-span-full"><span>System prompt 文件</span><strong class="font-mono break-all">{selectedRun.instructionPath}</strong></div>
                {/if}
                {#if selectedRun.logPath}
                  <div class="col-span-full"><span>日志文件</span><strong class="font-mono break-all">{selectedRun.logPath}</strong></div>
                {/if}
                {#if selectedRun.resultSummary}
                  <div class="col-span-full"><span>结果</span><strong>{selectedRun.resultSummary}</strong></div>
                {/if}
              </div>

              <div class="event-log mt-3" bind:this={logEl} onscroll={onLogScroll}>
                {#if !feed.length}
                  <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                    这个批次暂时没有输出。
                  </div>
                {:else}
                  {#each feed as item (item.event.id)}
                    <article class="event-row">
                      <div class="event-meta">
                        <span>{formatTime(item.event.timestamp)}</span>
                        <span class="event-kind">{item.event.kind}</span>
                      </div>
                      {#each item.segments as seg}
                        <div class="seg tone-{seg.tone}">
                          <div class="seg-head">
                            <span class="seg-icon">{seg.icon}</span>
                            <span class="seg-label">{seg.label}</span>
                            {#if seg.model}<span class="seg-model">{seg.model}</span>{/if}
                          </div>
                          {#if seg.chips?.length}
                            <div class="seg-chips">
                              {#each seg.chips as chip}
                                <span class="seg-chip">{#if chip.k}<b>{chip.k}</b>{/if}{chip.v}</span>
                              {/each}
                            </div>
                          {/if}
                          {#if seg.tool?.input != null && formatArgs(seg.tool.input)}
                            <pre class="seg-code">{formatArgs(seg.tool.input)}</pre>
                          {/if}
                          {#if seg.tool?.output}
                            <pre class="seg-out">{seg.tool.output}</pre>
                          {/if}
                          {#if seg.text}
                            <div class="seg-text">{seg.text}</div>
                          {/if}
                        </div>
                      {/each}
                      {#if item.event.event}
                        <details>
                          <summary>JSONL 原文</summary>
                          <pre class="json">{eventJson(item.event)}</pre>
                        </details>
                      {/if}
                    </article>
                  {/each}
                {/if}
              </div>
            {:else}
              <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                选择一个运行批次查看输出。
              </div>
            {/if}
          </div>
        </section>
      </div>
    {/if}
  </div>
</div>

<style>
  .runs {
    max-height: 68vh;
    overflow: auto;
  }

  .run-item {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: left;
    border: 1px solid var(--color-base-300);
    border-radius: 8px;
    background: var(--color-base-100);
  }

  .run-item:hover,
  .run-item.active {
    background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  }

  .run-main,
  .run-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .run-main .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .run-meta {
    flex-wrap: wrap;
    font-size: 0.72rem;
    opacity: 0.68;
  }

  .run-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--color-base-300);
    border-radius: 8px;
    background: var(--color-base-100);
  }

  .run-summary div {
    min-width: 0;
  }

  .run-summary span {
    display: block;
    font-size: 0.68rem;
    opacity: 0.6;
    margin-bottom: 0.1rem;
  }

  .run-summary strong {
    display: block;
    font-size: 0.78rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .col-span-full {
    grid-column: 1 / -1;
  }

  .event-log {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    max-height: 62vh;
    overflow: auto;
  }

  .event-row {
    border: 1px solid var(--color-base-300);
    background: var(--color-base-100);
    border-radius: 8px;
    padding: 0.5rem 0.65rem;
    min-width: 0;
  }

  .event-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.68rem;
    opacity: 0.55;
    margin-bottom: 0.4rem;
  }

  .event-kind {
    font-family: ui-monospace, monospace;
  }

  /* ---- 解析后的段落 ---- */
  .seg {
    border-left: 3px solid color-mix(in srgb, var(--color-base-content) 22%, transparent);
    border-radius: 4px;
    padding: 0.35rem 0.6rem;
    margin-bottom: 0.4rem;
    background: color-mix(in srgb, var(--color-base-200) 45%, transparent);
  }

  .seg:last-of-type {
    margin-bottom: 0;
  }

  .seg-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .seg-icon {
    font-size: 0.85rem;
    line-height: 1;
  }

  .seg-model {
    margin-left: auto;
    font-size: 0.66rem;
    font-weight: 500;
    opacity: 0.6;
    font-family: ui-monospace, monospace;
  }

  .seg-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.78rem;
    line-height: 1.5;
  }

  .seg-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .seg-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-base-content) 8%, transparent);
  }

  .seg-chip b {
    font-weight: 600;
    opacity: 0.6;
  }

  .seg-code,
  .seg-out {
    margin: 0.3rem 0 0;
    padding: 0.4rem 0.55rem;
    border-radius: 6px;
    font-size: 0.72rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 16rem;
    overflow: auto;
  }

  .seg-code {
    background: color-mix(in srgb, var(--color-warning) 12%, var(--color-base-100));
  }

  .seg-out {
    background: color-mix(in srgb, var(--color-base-300) 55%, transparent);
  }

  /* 段落语气配色 */
  .tone-thinking { border-left-color: color-mix(in srgb, var(--color-base-content) 35%, transparent); }
  .tone-thinking .seg-text { opacity: 0.72; font-style: italic; }
  .tone-assistant { border-left-color: var(--color-primary); }
  .tone-user { border-left-color: var(--color-secondary); }
  .tone-tool { border-left-color: var(--color-warning); }
  .tone-system { border-left-color: var(--color-info); }
  .tone-meta { border-left-color: color-mix(in srgb, var(--color-info) 60%, transparent); }
  .tone-success { border-left-color: var(--color-success); }
  .tone-error { border-left-color: var(--color-error); }
  .tone-error .seg-text { color: var(--color-error); }

  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.75rem;
    line-height: 1.45;
  }

  details {
    margin-top: 0.5rem;
  }

  summary {
    cursor: pointer;
    font-size: 0.7rem;
    opacity: 0.55;
  }

  .json {
    margin-top: 0.45rem;
    max-height: 20rem;
    overflow: auto;
    padding: 0.5rem;
    background: color-mix(in srgb, var(--color-base-300) 62%, transparent);
    border-radius: 6px;
  }

  @media (max-width: 960px) {
    .run-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
