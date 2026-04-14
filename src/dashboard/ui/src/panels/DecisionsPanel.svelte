<script>
  import { onDestroy, tick } from 'svelte';
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { escapeHtml, shortId, formatCodeActContent, isAtBottom, scrollToBottom, getGroupLabel, getPlatform, platformLabel } from '../lib/utils.js';

  let decisions = [];
  let history = [];
  let pollTimer = null;
  let decisionsEl;
  let historyEl;
  let wasBottomD = true;
  let wasBottomH = true;

  $: if ($activeTab === 'decisions') {
    startPolling();
  } else {
    stopPolling();
  }

  function startPolling() {
    refresh();
    if (!pollTimer) {
      pollTimer = setInterval(refresh, 5000);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function refresh() {
    const [d, h] = await Promise.all([
      api('/decisions').catch(() => []),
      api('/main-agent/history').catch(() => []),
    ]);
    // 检测是否有新数据
    const hadNewDecisions = d && d.length !== decisions.length;
    const hadNewHistory = h && h.length !== history.length;
    decisions = d || [];
    history = h || [];

    await tick();
    if (hadNewDecisions && decisionsEl && wasBottomD) scrollToBottom(decisionsEl);
    if (hadNewHistory && historyEl && wasBottomH) scrollToBottom(historyEl);
  }

  function onScrollD() { if (decisionsEl) wasBottomD = isAtBottom(decisionsEl); }
  function onScrollH() { if (historyEl) wasBottomH = isAtBottom(historyEl); }

  function quickQueryGroup(chatId) {
    activeTab.set('memory');
    window.dispatchEvent(new CustomEvent('quickQueryGroup', { detail: { chatId } }));
  }

  /** 决策类型分析（从 decision 文本中提取） */
  function decisionMeta(text) {
    if (!text) return { cls: '', icon: 'fa-clipboard-list' };
    if (text.startsWith('CALLBACK:')) return { cls: 'dec-callback', icon: 'fa-arrows-rotate' };
    if (text.startsWith('DEFERRED:')) return { cls: 'dec-deferred', icon: 'fa-hourglass-half' };
    if (text.includes('SKIP') || text.includes('skip')) return { cls: 'dec-skip', icon: 'fa-forward-step' };
    if (text.includes('CodeAct') || text.includes('codeact')) return { cls: 'dec-codeact', icon: 'fa-gears' };
    if (text.includes('attend') || text.includes('ATTEND')) return { cls: 'dec-attend', icon: 'fa-eye' };
    return { cls: 'dec-default', icon: 'fa-clipboard-list' };
  }

  onDestroy(() => stopPolling());
</script>

<div class="dp-layout">
  <!-- Decisions -->
  <div class="dp-col card bg-base-100">
    <div class="card-body p-3 min-h-0 flex flex-col">
      <div class="flex justify-between items-center shrink-0 mb-2">
        <h3 class="card-title text-sm">
          最近决策
          <span class="badge badge-sm badge-ghost ml-1">{decisions.length}</span>
        </h3>
      </div>

      <div bind:this={decisionsEl} class="overflow-y-auto flex-1 min-h-0 space-y-1" onscroll={onScrollD}>
        {#each decisions as d, i}
          {@const meta = decisionMeta(d.decision || d.content)}
          <div class="dp-item {meta.cls}" style="animation-delay: {Math.min(i * 0.02, 0.5)}s">
            <div class="dp-item-header">
              <span class="dp-icon"><i class="fa-solid {meta.icon}"></i></span>
              <button class="dp-chat clickable-link" onclick={() => quickQueryGroup(d.chatId)}>
                {#if getPlatform(d.chatId)}<span class="platform-badge platform-{getPlatform(d.chatId)}">{platformLabel(getPlatform(d.chatId))}</span>{/if}
                {getGroupLabel(d.chatId)}
              </button>
              <span class="dp-time">{d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : ''}</span>
            </div>
            <div class="dp-content">{d.decision || d.content || JSON.stringify(d)}</div>
          </div>
        {/each}
      </div>
    </div>
  </div>

  <!-- Main Agent Conversation History -->
  <div class="dp-col card bg-base-100">
    <div class="card-body p-3 min-h-0 flex flex-col">
      <div class="flex justify-between items-center shrink-0 mb-2">
        <h3 class="card-title text-sm">
          主 Agent 对话历史
          <span class="badge badge-sm badge-ghost ml-1">{history.length}</span>
        </h3>
      </div>

      <div bind:this={historyEl} class="overflow-y-auto flex-1 min-h-0 space-y-2" onscroll={onScrollH}>
        {#each history as msg}
          {@const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
          <div class="codeact-msg role-{msg.role}">
            <span class="role-label">{msg.role}</span>
            <div class="mt-1 text-xs">{@html formatCodeActContent(content)}</div>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
/* ── Layout ── */
.dp-layout {
  display: flex;
  gap: 1rem;
  height: calc(100vh - 280px);
  overflow: hidden;
}

.dp-col {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ── Decision items ── */
.dp-item {
  padding: 0.4rem 0.6rem;
  border-radius: 0.375rem;
  border-left: 3px solid transparent;
  animation: dpFadeIn 0.3s ease-out both;
}

@keyframes dpFadeIn {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}

.dp-item.dec-callback { border-left-color: var(--color-info); background: color-mix(in srgb, var(--color-info) 5%, transparent); }
.dp-item.dec-deferred { border-left-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 5%, transparent); }
.dp-item.dec-skip { border-left-color: var(--color-base-content); background: color-mix(in srgb, var(--color-base-content) 3%, transparent); }
.dp-item.dec-codeact { border-left-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 5%, transparent); }
.dp-item.dec-attend { border-left-color: var(--color-success); background: color-mix(in srgb, var(--color-success) 5%, transparent); }
.dp-item.dec-default { border-left-color: var(--color-secondary); background: color-mix(in srgb, var(--color-secondary) 3%, transparent); }

.dp-item-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.15rem;
}

.dp-icon {
  font-size: 0.75rem;
  flex-shrink: 0;
}

.dp-chat {
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dp-time {
  font-size: 0.6rem;
  opacity: 0.5;
  margin-left: auto;
  white-space: nowrap;
}

.dp-content {
  font-size: 0.72rem;
  line-height: 1.4;
  word-break: break-word;
  opacity: 0.85;
}

/* ── Mobile ── */
@media (max-width: 768px) {
  .dp-layout {
    flex-direction: column;
    height: calc(100vh - 200px);
  }
  .dp-col {
    max-height: 45vh;
  }
}
</style>
