<script>
  import { appState, selectedCodeActChatId, activeTab, codeActProgress, clearCodeActProgress } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { shortId, getGroupLabel, formatCodeActContent, isAtBottom, scrollToBottom, getPlatform, platformLabel } from '../lib/utils.js';
  import { onDestroy, tick } from 'svelte';

  let sessionData = { session: [], queueSize: 0, sessionSize: '-', executionCount: '-', isProcessing: false };
  let pollTimer = null;
  let sessionEl;
  let wasBottom = true;
  let showSidebar = false;

  $: groups = $appState.groups;
  $: if ($activeTab === 'codeact' && $selectedCodeActChatId) refreshSession($selectedCodeActChatId);

  // 获取当前选中 chat 的实时进度事件
  $: progressEvents = $selectedCodeActChatId ? ($codeActProgress[$selectedCodeActChatId] || []) : [];

  // 自动滚动：当进度事件或 session 数据更新时
  $: if ((progressEvents || sessionData) && sessionEl) {
    wasBottom = isAtBottom(sessionEl);
    tick().then(() => { if (wasBottom) scrollToBottom(sessionEl); });
  }

  async function selectChat(chatId) {
    selectedCodeActChatId.set(chatId);
    showSidebar = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    await refreshSession(chatId, true);
  }

  async function refreshSession(chatId, forceScroll = false) {
    if (!chatId) return;
    const shouldFollow = forceScroll || (sessionEl ? isAtBottom(sessionEl) : true);
    const data = await api(`/codeact/${chatId}`);
    sessionData = data;
    await tick();
    if (sessionEl && shouldFollow) scrollToBottom(sessionEl);

    if (data.isProcessing && !pollTimer) {
      pollTimer = setInterval(() => refreshSession(chatId), 5000);
    } else if (!data.isProcessing && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function onSessionScroll() {
    if (sessionEl) wasBottom = isAtBottom(sessionEl);
  }

  async function cancelCodeAct() {
    if (!$selectedCodeActChatId) return;
    if (!confirm(`确认取消 ${$selectedCodeActChatId} 的 CodeAct 执行？`)) return;
    await api(`/codeact/${$selectedCodeActChatId}/cancel`, { method: 'POST' });
    await refreshSession($selectedCodeActChatId);
  }

  async function resetCodeActSession() {
    if (!$selectedCodeActChatId || sessionData.isProcessing) return;
    if (!confirm(`确认重置 ${$selectedCodeActChatId} 的 CodeAct Session？这会清空当前 runner 上下文。`)) return;
    await api(`/codeact/${$selectedCodeActChatId}/reset-session`, { method: 'POST' });
    clearCodeActProgress($selectedCodeActChatId);
    await refreshSession($selectedCodeActChatId, true);
  }

  /** 获取 phase 的中文标签和样式类 */
  function phaseInfo(phase) {
    switch(phase) {
      case 'thinking': return { label: '💭 思考', cls: 'phase-thinking' };
      case 'executing': return { label: '⚙️ 执行', cls: 'phase-executing' };
      case 'observation': return { label: '📋 输出', cls: 'phase-observation' };
      case 'new_messages': return { label: '📩 新消息', cls: 'phase-new-messages' };
      case 'task': return { label: '📝 任务', cls: 'phase-task' };
      case 'end': return { label: '✅ 结束', cls: 'phase-end' };
      default: return { label: phase, cls: '' };
    }
  }

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<div class="ca-panel-layout">
  <!-- Mobile sidebar toggle -->
  <button class="mobile-sidebar-toggle ca-mobile-toggle" onclick={() => showSidebar = true}>
    ☰ 群组
  </button>

  <!-- Sidebar overlay -->
  {#if showSidebar}
    <button class="mobile-sidebar-overlay ca-sidebar-overlay" aria-label="关闭侧栏" onclick={() => showSidebar = false}></button>
  {/if}

  <!-- Chat list -->
  <div class="ca-sidebar" class:ca-sidebar-open={showSidebar}>
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0">
        <h3 class="card-title text-sm">群组选择</h3>
        <div class="space-y-1 overflow-y-auto flex-1 min-h-0">
          {#each groups as g}
            {@const isActive = $selectedCodeActChatId === g.chatId}
            <button class="chat-item" class:active={isActive}
                 onclick={() => selectChat(g.chatId)} title={g.chatId}>
              <span class="flex items-center gap-1">
                {#if getPlatform(g.chatId)}<span class="platform-badge platform-{getPlatform(g.chatId)}">{platformLabel(getPlatform(g.chatId))}</span>{/if}
                {getGroupLabel(g.chatId)}
              </span>
              <span class="flex items-center gap-1">
                {#if g.codeActProcessing}
                  <span class="badge badge-xs badge-warning animate-pulse">执行中</span>
                {:else if g.codeActSessionSize > 0}
                  <span class="badge badge-sm badge-ghost">{g.codeActSessionSize}</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- Session stream -->
  <div class="ca-content">
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0 flex flex-col">
        <div class="flex justify-between items-center shrink-0 mb-2 ca-header">
          <h3 class="card-title text-sm">
            CodeAct Session
            {#if $selectedCodeActChatId}
              {#if getPlatform($selectedCodeActChatId)}<span class="platform-badge platform-{getPlatform($selectedCodeActChatId)}">{platformLabel(getPlatform($selectedCodeActChatId))}</span>{/if}
              <span class="text-xs opacity-60">{getGroupLabel($selectedCodeActChatId)}</span>
            {/if}
            {#if sessionData.isProcessing}
              <span class="badge badge-xs badge-warning animate-pulse ml-1">执行中</span>
            {/if}
          </h3>
          {#if $selectedCodeActChatId}
            <div class="flex gap-1">
              <button
                class="btn btn-xs btn-ghost"
                title={sessionData.isProcessing ? '执行中，请先取消当前任务再重置 Session' : '清空当前 CodeAct runner 上下文'}
                disabled={sessionData.isProcessing}
                onclick={resetCodeActSession}
              >
                <i class="fa-solid fa-rotate-left"></i>
                Reset Session
              </button>
              {#if sessionData.isProcessing}
                <button class="btn btn-xs btn-error" onclick={cancelCodeAct}>取消执行</button>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Stats -->
        <div class="stats shadow w-full mb-3 text-xs shrink-0">
          <div class="stat py-2">
            <div class="stat-title text-xs">Session 大小</div>
            <div class="stat-value text-sm">{sessionData.sessionSize ?? '-'}</div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">执行次数</div>
            <div class="stat-value text-sm">{sessionData.executionCount ?? '-'}</div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">队列大小</div>
            <div class="stat-value text-sm">{sessionData.queueSize ?? '-'}</div>
          </div>
        </div>

        <!-- Session content + real-time progress -->
        <div bind:this={sessionEl} class="overflow-y-auto flex-1 min-h-0 space-y-2" onscroll={onSessionScroll}>
          <!-- Historical session messages (from REST API) -->
          {#each (sessionData.session || []) as msg}
            {@const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
            <div class="codeact-msg role-{msg.role}">
              <span class="role-label">{msg.role}</span>
              <div class="mt-1 text-xs">{@html formatCodeActContent(content)}</div>
            </div>
          {/each}

          <!-- Real-time progress events (from WebSocket) -->
          {#if progressEvents.length > 0}
            <div class="divider text-xs opacity-50">实时进度</div>
            {#each progressEvents as evt}
              {@const info = phaseInfo(evt.phase)}
              <div class="progress-event {info.cls}" class:is-end={evt.phase === 'end'}>
                <div class="progress-header">
                  <span class="phase-badge">{info.label}</span>
                  <span class="turn-label">Turn {evt.turn}</span>
                  <span class="event-time">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                </div>
                {#if evt.thinking}
                  <div class="progress-content thinking-content">
                    {@html formatCodeActContent(evt.thinking)}
                  </div>
                {/if}
                {#if evt.codeBlocks && evt.codeBlocks.length > 0}
                  <div class="progress-content code-content">
                    {#each evt.codeBlocks as block}
                      <pre class="code-block"><code>{block.code}</code></pre>
                    {/each}
                  </div>
                {/if}
                {#if evt.executionOutput}
                  <div class="progress-content output-content">
                    <pre class="output-block">{evt.executionOutput}</pre>
                  </div>
                {/if}
                {#if evt.userMessage}
                  <div class="progress-content user-message-content">
                    <pre class="output-block">{evt.userMessage}</pre>
                  </div>
                {/if}
                {#if evt.endReason}
                  <div class="end-reason">结束原因: {evt.endReason}</div>
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
.ca-panel-layout {
  display: flex;
  gap: 1rem;
  height: calc(100vh - 280px);
  overflow: hidden;
}

.ca-mobile-toggle { display: none; }
.ca-sidebar-overlay { display: none; }

.ca-sidebar {
  width: 16rem;
  flex-shrink: 0;
  min-height: 0;
}

.ca-content {
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

/* ── Session messages ── */
.codeact-msg {
  padding: 0.5rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  border-left: 3px solid transparent;
}

.codeact-msg.role-system { border-left-color: var(--color-info); background: color-mix(in srgb, var(--color-info) 5%, transparent); }
.codeact-msg.role-user { border-left-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 5%, transparent); }
.codeact-msg.role-assistant { border-left-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 8%, transparent); }

.role-label {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  padding: 0.1rem 0.3rem;
  border-radius: 0.2rem;
  background: color-mix(in srgb, var(--color-secondary) 15%, transparent);
  color: var(--color-secondary);
}

/* ── Progress events (real-time) ── */
.progress-event {
  padding: 0.5rem;
  border-radius: 0.375rem;
  border-left: 3px solid transparent;
  animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.progress-event.phase-thinking { border-left-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 5%, transparent); }
.progress-event.phase-executing { border-left-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 5%, transparent); }
.progress-event.phase-observation { border-left-color: var(--color-success); background: color-mix(in srgb, var(--color-success) 5%, transparent); }
.progress-event.phase-new-messages { border-left-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 8%, transparent); }
.progress-event.phase-task { border-left-color: var(--color-info); background: color-mix(in srgb, var(--color-info) 8%, transparent); }
.progress-event.phase-end { border-left-color: var(--color-info); background: color-mix(in srgb, var(--color-info) 5%, transparent); }

.progress-header {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.25rem;
}

.phase-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 0.2rem;
  background: color-mix(in srgb, var(--color-secondary) 15%, transparent);
}

.turn-label {
  font-size: 0.65rem;
  opacity: 0.6;
}

.event-time {
  font-size: 0.6rem;
  opacity: 0.5;
  margin-left: auto;
}

.progress-content {
  margin-top: 0.25rem;
  font-size: 0.75rem;
}

.thinking-content {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}

.code-content pre,
.output-block {
  font-size: 0.7rem;
  padding: 0.4rem;
  border-radius: 0.25rem;
  background: color-mix(in srgb, var(--color-base-300) 50%, transparent);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0.2rem 0;
}

.end-reason {
  font-size: 0.65rem;
  opacity: 0.7;
  margin-top: 0.25rem;
  font-style: italic;
}

/* ── Mobile ── */
@media (max-width: 768px) {
  .ca-panel-layout {
    flex-direction: column;
    height: calc(100vh - 200px);
  }
  .ca-mobile-toggle { display: flex !important; }
  .ca-sidebar {
    display: none;
    width: 100%;
  }
  .ca-sidebar.ca-sidebar-open {
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
    animation: slideInLeft 0.2s ease-out;
  }
  @keyframes slideInLeft {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }
  .ca-content { flex: 1; min-height: 0; }
  .ca-header { flex-wrap: wrap; gap: 0.5rem; }
}
</style>
