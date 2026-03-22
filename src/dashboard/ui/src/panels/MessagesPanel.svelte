<script>
  import { onMount, tick } from 'svelte';
  import { messages, selectedChatId, appState, activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { escapeHtml, shortId, getGroupLabel, isAtBottom, scrollToBottom, getPlatform, platformLabel } from '../lib/utils.js';

  let streamEl;

  $: allChatIds = [...new Set([...$appState.groups.map(g => g.chatId), ...$messages.map(m => m.chatId)])];
  $: filtered = $selectedChatId ? $messages.filter(m => m.chatId === $selectedChatId) : $messages;
  $: displayMessages = filtered.slice(-200);

  async function selectChat(chatId) {
    selectedChatId.set(chatId);
    if (chatId) {
      try {
        const history = await api(`/messages/${chatId}?limit=100`);
        if (Array.isArray(history) && history.length > 0) {
          messages.update(msgs => {
            const existingIds = new Set(msgs.map(m => m.messageId || m.id));
            const newMsgs = history
              .filter(m => !existingIds.has(m.messageId))
              .map(m => ({
                chatId: m.chatId, messageId: m.messageId,
                userId: m.userId, displayName: m.displayName,
                text: m.text, timestamp: m.timestamp,
              }));
            if (newMsgs.length > 0) {
              msgs.push(...newMsgs);
              msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
              if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
            }
            return msgs;
          });
        }
      } catch { /* ignore */ }
    }
  }

  function quickQueryUser(userId, chatId) {
    activeTab.set('memory');
    // will be handled by MemoryPanel
    window.__quickQueryUser = { userId, chatId };
    window.dispatchEvent(new CustomEvent('quickQueryUser', { detail: { userId, chatId } }));
  }

  // Auto-scroll on new messages
  let wasBottom = true;
  $: if (displayMessages && streamEl) {
    wasBottom = isAtBottom(streamEl);
    tick().then(() => { if (wasBottom) scrollToBottom(streamEl); });
  }
</script>

<div class="flex gap-4 h-[calc(100vh-280px)] overflow-hidden">
  <!-- Chat list -->
  <div class="w-64 shrink-0 min-h-0">
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0">
        <h3 class="card-title text-sm">群组列表</h3>
        <div class="space-y-1 overflow-y-auto flex-1 min-h-0">
          <button class="chat-item" class:active={!$selectedChatId}
               onclick={() => selectChat(null)}>全部</button>
          {#each allChatIds as chatId}
            {@const count = $messages.filter(m => m.chatId === chatId).length}
            {@const plat = getPlatform(chatId)}
            <button class="chat-item" class:active={$selectedChatId === chatId}
                 onclick={() => selectChat(chatId)} title={chatId}>
              <span class="flex items-center gap-1">
                {#if plat}<span class="platform-badge platform-{plat}">{platformLabel(plat)}</span>{/if}
                {getGroupLabel(chatId)}
              </span>
              <span class="badge badge-sm">{count}</span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- Message stream -->
  <div class="flex-1 min-w-0 min-h-0">
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0 flex flex-col">
        <h3 class="card-title text-sm shrink-0">
          消息流
          {#if $selectedChatId}
            {#if getPlatform($selectedChatId)}<span class="platform-badge platform-{getPlatform($selectedChatId)}">{platformLabel(getPlatform($selectedChatId))}</span>{/if}
            <span class="text-xs opacity-60">{getGroupLabel($selectedChatId)}</span>
          {:else}
            <span class="text-xs opacity-60">全部</span>
          {/if}
        </h3>
        <div bind:this={streamEl} class="overflow-y-auto flex-1 min-h-0 space-y-1 font-mono text-sm">
          {#each displayMessages as m}
            {@const time = new Date(m.timestamp).toLocaleTimeString()}
            {@const isAgent = m.userId === 'agent' || m.userId === 'self'}
            {@const isMention = m.mentionsAgent || m.isDirectMessage}
            <div class="msg-item" class:is-agent={isAgent} class:is-mention={isMention}>
              <span class="msg-time">{time}</span>
              {#if !$selectedChatId}
                <span class="msg-group-tag" title={m.chatId}>
                  {#if getPlatform(m.chatId)}<span class="platform-badge platform-{getPlatform(m.chatId)}" style="font-size:0.5rem">{platformLabel(getPlatform(m.chatId))}</span>{/if}
                  {getGroupLabel(m.chatId)}
                </span>
              {/if}
              {#if isAgent}
                <span class="msg-user">🤖 Agent</span>
              {:else}
                <button class="msg-user clickable-link" onclick={() => quickQueryUser(m.userId, m.chatId)}>
                  {m.displayName || m.userId}
                </button>
              {/if}
              <span class="msg-text">{(m.text || '').slice(0, 500)}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
.msg-time {
  color: var(--color-secondary);
  font-size: 0.7rem;
  min-width: 4rem;
  background: color-mix(in srgb, var(--color-secondary) 10%, transparent);
  padding: 0.1rem 0.3rem;
  border-radius: 0.2rem;
  flex-shrink: 0;
}

.msg-user {
  color: var(--color-primary);
  font-weight: 600;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  padding: 0.1rem 0.3rem;
  border-radius: 0.2rem;
  text-decoration: none !important;
  flex-shrink: 0;
}

.msg-text { word-break: break-word; }

.msg-item {
  display: flex;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  transition: background 0.15s;
  align-items: baseline;
}

.msg-item:hover { background: var(--color-base-200); }
.msg-item.is-agent { background: color-mix(in srgb, var(--color-primary) 8%, transparent); }
.msg-item.is-mention { border-left: 2px solid var(--color-warning); }

.msg-group-tag {
  font-size: 0.65rem;
  padding: 0.1rem 0.4rem;
  border-radius: 0.2rem;
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  color: var(--color-accent);
  white-space: nowrap;
  width: 7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  text-align: center;
  display: inline-block;
}

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
</style>
