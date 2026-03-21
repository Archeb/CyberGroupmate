<script>
  import { appState, selectedCodeActChatId, activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { shortId, getGroupLabel, formatCodeActContent, isAtBottom, scrollToBottom } from '../lib/utils.js';
  import { onDestroy, tick } from 'svelte';

  let sessionData = { session: [], queueSize: 0, sessionSize: '-', executionCount: '-', isProcessing: false };
  let pollTimer = null;
  let sessionEl;

  $: groups = $appState.groups;
  $: if ($activeTab === 'codeact' && $selectedCodeActChatId) refreshSession($selectedCodeActChatId);

  async function selectChat(chatId) {
    selectedCodeActChatId.set(chatId);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    await refreshSession(chatId);
  }

  async function refreshSession(chatId) {
    if (!chatId) return;
    const data = await api(`/codeact/${chatId}`);
    sessionData = data;
    await tick();
    if (sessionEl) scrollToBottom(sessionEl);

    if (data.isProcessing && !pollTimer) {
      pollTimer = setInterval(() => refreshSession(chatId), 2000);
    } else if (!data.isProcessing && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function cancelCodeAct() {
    if (!$selectedCodeActChatId) return;
    if (!confirm(`确认取消 ${$selectedCodeActChatId} 的 CodeAct 执行？`)) return;
    await api(`/codeact/${$selectedCodeActChatId}/cancel`, { method: 'POST' });
    await refreshSession($selectedCodeActChatId);
  }

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<div class="flex gap-4">
  <div class="w-64 shrink-0 card bg-base-100">
    <div class="card-body p-3">
      <h3 class="card-title text-sm">群组选择</h3>
      <div class="space-y-1 overflow-y-auto">
        {#each groups as g}
          {@const active = g.codeActProcessing ? '🔄' : ''}
          <div class="chat-item" class:active={$selectedCodeActChatId === g.chatId}
               onclick={() => selectChat(g.chatId)}>
            <span>{shortId(g.chatId)}</span>{active}
          </div>
        {/each}
      </div>
    </div>
  </div>

  <div class="flex-1 min-w-0 card bg-base-100 overflow-hidden">
    <div class="card-body p-4 overflow-hidden">
      <div class="flex justify-between items-center mb-2">
        <h3 class="card-title text-sm">CodeAct Session <span class="text-xs opacity-60">{$selectedCodeActChatId ? getGroupLabel($selectedCodeActChatId) : ''}</span></h3>
        {#if sessionData.isProcessing}
          <button class="btn btn-xs btn-error" onclick={cancelCodeAct}>取消执行</button>
        {/if}
      </div>
      <div class="stats shadow w-full mb-3 text-xs">
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
      <div bind:this={sessionEl} class="space-y-2 overflow-y-auto overflow-x-hidden max-h-[50vh]">
        {#each (sessionData.session || []) as msg}
          {@const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
          <div class="codeact-msg role-{msg.role}">
            <span class="role-label">{msg.role}</span>
            <div class="mt-1 text-xs">{@html formatCodeActContent(content.slice(0, 5000))}</div>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>
