<script>
  import { appState, selectedRecordingChatId, activeTab, recordingProgress } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { getGroupLabel, isAtBottom, scrollToBottom, getPlatform, platformLabel } from '../lib/utils.js';
  import { onDestroy, tick } from 'svelte';

  let pipelineStatus = { bufferSize: 0, isEagerMode: false, isFlushing: false, disposed: false };
  let pollTimer = null;
  let streamEl;
  let wasBottom = true;
  let showSidebar = false;

  $: groups = $appState.groups;
  $: if ($activeTab === 'recording' && $selectedRecordingChatId) refreshStatus($selectedRecordingChatId);

  // 获取当前选中 chat 的实时 recording 事件
  $: events = $selectedRecordingChatId ? ($recordingProgress[$selectedRecordingChatId] || []) : [];

  // 自动滚动
  $: if ((events || pipelineStatus) && streamEl) {
    wasBottom = isAtBottom(streamEl);
    tick().then(() => { if (wasBottom) scrollToBottom(streamEl); });
  }

  async function selectChat(chatId) {
    selectedRecordingChatId.set(chatId);
    showSidebar = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    await refreshStatus(chatId);
    // 开启轮询刷新 status
    pollTimer = setInterval(() => refreshStatus(chatId), 5000);
  }

  async function refreshStatus(chatId) {
    if (!chatId) return;
    try {
      const data = await api(`/recording/${chatId}`);
      pipelineStatus = data;
    } catch { /* ignore */ }
  }

  function eventInfo(type) {
    switch(type) {
      case 'recording:flush-start': return { label: '🚀 Flush 开始', cls: 'evt-flush-start' };
      case 'recording:flush-complete': return { label: '✅ Flush 完成', cls: 'evt-flush-complete' };
      case 'recording:flush-error': return { label: '❌ Flush 错误', cls: 'evt-flush-error' };
      case 'recording:triage-passed': return { label: '🎯 Triage 通过', cls: 'evt-triage-passed' };
      default: return { label: type, cls: '' };
    }
  }

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<div class="rp-panel-layout">
  <!-- Mobile sidebar toggle -->
  <button class="mobile-sidebar-toggle rp-mobile-toggle" onclick={() => showSidebar = true}>
    ☰ 群组
  </button>

  <!-- Sidebar overlay -->
  {#if showSidebar}
    <button class="mobile-sidebar-overlay rp-sidebar-overlay" aria-label="关闭侧栏" onclick={() => showSidebar = false}></button>
  {/if}

  <!-- Chat list -->
  <div class="rp-sidebar" class:rp-sidebar-open={showSidebar}>
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0">
        <h3 class="card-title text-sm">群组选择</h3>
        <div class="space-y-1 overflow-y-auto flex-1 min-h-0">
          {#each groups as g}
            {@const isActive = $selectedRecordingChatId === g.chatId}
            <button class="chat-item" class:active={isActive}
                 onclick={() => selectChat(g.chatId)} title={g.chatId}>
              <span class="flex items-center gap-1">
                {#if getPlatform(g.chatId)}<span class="platform-badge platform-{getPlatform(g.chatId)}">{platformLabel(getPlatform(g.chatId))}</span>{/if}
                {getGroupLabel(g.chatId)}
              </span>
              <span class="flex items-center gap-1">
                {#if g.bufferSize > 0}
                  <span class="badge badge-xs badge-info">{g.bufferSize}</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- Content area -->
  <div class="rp-content">
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0 flex flex-col">
        <div class="flex justify-between items-center shrink-0 mb-2 rp-header">
          <h3 class="card-title text-sm">
            Recording Pipeline
            {#if $selectedRecordingChatId}
              {#if getPlatform($selectedRecordingChatId)}<span class="platform-badge platform-{getPlatform($selectedRecordingChatId)}">{platformLabel(getPlatform($selectedRecordingChatId))}</span>{/if}
              <span class="text-xs opacity-60">{getGroupLabel($selectedRecordingChatId)}</span>
            {/if}
            {#if pipelineStatus.isFlushing}
              <span class="badge badge-xs badge-warning animate-pulse ml-1">Flushing</span>
            {/if}
          </h3>
        </div>

        <!-- Stats -->
        <div class="stats shadow w-full mb-3 text-xs shrink-0">
          <div class="stat py-2">
            <div class="stat-title text-xs">缓冲消息数</div>
            <div class="stat-value text-sm">{pipelineStatus.bufferSize ?? 0}</div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">模式</div>
            <div class="stat-value text-sm">
              {#if pipelineStatus.disposed}
                <span class="text-error">已停止</span>
              {:else if pipelineStatus.isEagerMode}
                <span class="text-warning">加速</span>
              {:else}
                <span class="text-success">正常</span>
              {/if}
            </div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">Flush 状态</div>
            <div class="stat-value text-sm">
              {#if pipelineStatus.isFlushing}
                <span class="text-warning">执行中</span>
              {:else}
                <span class="text-success">空闲</span>
              {/if}
            </div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">事件数</div>
            <div class="stat-value text-sm">{events.length}</div>
          </div>
        </div>

        <!-- Event stream -->
        <div bind:this={streamEl} class="overflow-y-auto flex-1 min-h-0 space-y-2">
          {#if events.length === 0}
            <div class="text-center text-xs opacity-40 mt-8">
              {#if $selectedRecordingChatId}
                暂无 Recording Pipeline 事件
              {:else}
                ← 请选择一个群组
              {/if}
            </div>
          {:else}
            {#each events as evt}
              {@const info = eventInfo(evt._type)}
              <div class="rp-event {info.cls}">
                <div class="rp-event-header">
                  <span class="rp-event-badge">{info.label}</span>
                  <span class="rp-event-time">{new Date(evt._timestamp).toLocaleTimeString()}</span>
                </div>

                {#if evt._type === 'recording:flush-start'}
                  <div class="rp-event-body">处理 <strong>{evt.messageCount}</strong> 条消息</div>
                {/if}

                {#if evt._type === 'recording:flush-complete'}
                  <div class="rp-event-body">
                    产出 <strong>{evt.topicCount}</strong> 个话题
                    {#if evt.topics && evt.topics.length > 0}
                      <div class="rp-topic-list">
                        {#each evt.topics as t}
                          <div class="rp-topic-item">
                            <span class="badge badge-xs badge-outline">{t.state}</span>
                            <span class="rp-topic-label">{t.label}</span>
                            <span class="rp-topic-meta">{t.messageCount} 条</span>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}

                {#if evt._type === 'recording:flush-error'}
                  <div class="rp-event-body text-error">{evt.error}</div>
                {/if}

                {#if evt._type === 'recording:triage-passed'}
                  <div class="rp-event-body">
                    <div>话题: <strong>{evt.topicLabel}</strong></div>
                    {#if evt.decision}
                      <div class="rp-decision">
                        <span class="badge badge-xs" class:badge-success={evt.decision.should_intervene} class:badge-ghost={!evt.decision.should_intervene}>
                          {evt.decision.should_intervene ? '介入' : '观望'}
                        </span>
                        {#if evt.decision.callbackPotential > 0}
                          <span class="badge badge-xs badge-info">cbp: {evt.decision.callbackPotential}</span>
                        {/if}
                      </div>
                      {#if evt.decision.reason}
                        <div class="rp-decision-reason">{evt.decision.reason}</div>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
/* ── Layout ── */
.rp-panel-layout {
  display: flex;
  gap: 1rem;
  height: calc(100vh - 280px);
  overflow: hidden;
}

.rp-mobile-toggle { display: none; }
.rp-sidebar-overlay { display: none; }

.rp-sidebar {
  width: 16rem;
  flex-shrink: 0;
  min-height: 0;
}

.rp-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ── Sidebar chat items ── */
.chat-item {
  padding: 0.35rem 0.5rem;
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.8rem;
  transition: background 0.15s;
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
}

.chat-item:hover { background: var(--color-base-200); }
.chat-item.active { background: color-mix(in srgb, var(--color-primary) 15%, transparent); color: var(--color-primary); }

/* ── Event items ── */
.rp-event {
  padding: 0.5rem;
  border-radius: 0.375rem;
  border-left: 3px solid transparent;
  animation: rpFadeIn 0.3s ease-out;
}

@keyframes rpFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.rp-event.evt-flush-start { border-left-color: var(--color-info); background: color-mix(in srgb, var(--color-info) 5%, transparent); }
.rp-event.evt-flush-complete { border-left-color: var(--color-success); background: color-mix(in srgb, var(--color-success) 5%, transparent); }
.rp-event.evt-flush-error { border-left-color: var(--color-error); background: color-mix(in srgb, var(--color-error) 5%, transparent); }
.rp-event.evt-triage-passed { border-left-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 5%, transparent); }

.rp-event-header {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.25rem;
}

.rp-event-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 0.2rem;
  background: color-mix(in srgb, var(--color-secondary) 15%, transparent);
}

.rp-event-time {
  font-size: 0.6rem;
  opacity: 0.5;
  margin-left: auto;
}

.rp-event-body {
  font-size: 0.75rem;
  margin-top: 0.25rem;
  line-height: 1.4;
}

/* ── Topic list in flush-complete ── */
.rp-topic-list {
  margin-top: 0.3rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.rp-topic-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.7rem;
  padding: 0.15rem 0.3rem;
  border-radius: 0.2rem;
  background: color-mix(in srgb, var(--color-base-300) 30%, transparent);
}

.rp-topic-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rp-topic-meta {
  font-size: 0.6rem;
  opacity: 0.6;
  white-space: nowrap;
}

/* ── Triage decision ── */
.rp-decision {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  margin-top: 0.2rem;
}

.rp-decision-type {
  font-size: 0.65rem;
  opacity: 0.7;
  font-family: monospace;
}

.rp-decision-conf {
  font-size: 0.6rem;
  opacity: 0.5;
  margin-left: auto;
}

.rp-decision-reason {
  font-size: 0.65rem;
  opacity: 0.7;
  margin-top: 0.15rem;
  font-style: italic;
}

/* ── Mobile ── */
@media (max-width: 768px) {
  .rp-panel-layout {
    flex-direction: column;
    height: calc(100vh - 200px);
  }
  .rp-mobile-toggle { display: flex !important; }
  .rp-sidebar {
    display: none;
    width: 100%;
  }
  .rp-sidebar.rp-sidebar-open {
    display: block;
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 75vw;
    max-width: 300px;
    z-index: 100;
    background: var(--color-base-100);
    box-shadow: 4px 0 20px rgba(0,0,0,0.3);
    padding: 0.5rem;
    overflow-y: auto;
    animation: rpSlideIn 0.2s ease-out;
  }
  @keyframes rpSlideIn {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }
  .rp-content { flex: 1; min-height: 0; }
  .rp-header { flex-wrap: wrap; gap: 0.5rem; }
}
</style>
