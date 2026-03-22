<script>
  import { onMount } from 'svelte';
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { escapeHtml, shortId, formatCodeActContent, getPlatform, platformLabel } from '../lib/utils.js';

  let decisions = [];
  let history = [];

  $: if ($activeTab === 'decisions') refresh();

  async function refresh() {
    decisions = await api('/decisions') || [];
    history = await api('/main-agent/history') || [];
  }

  function quickQueryGroup(chatId) {
    activeTab.set('memory');
    window.dispatchEvent(new CustomEvent('quickQueryGroup', { detail: { chatId } }));
  }
</script>

<div class="flex gap-4">
  <div class="w-50 flex-1 card bg-base-100">
    <div class="card-body p-4 overflow-hidden">
      <h3 class="card-title text-sm mb-2">最近决策</h3>
      <div class="space-y-1 overflow-y-auto max-h-[60vh] font-mono text-xs">
        {#each decisions as d}
          <div class="decision-item">
            <span class="opacity-50">{d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : ''}</span>
            <button class="clickable-link" onclick={() => quickQueryGroup(d.chatId)}>
              {#if getPlatform(d.chatId)}<span class="platform-badge platform-{getPlatform(d.chatId)}">{platformLabel(getPlatform(d.chatId))}</span>{/if}
              {shortId(d.chatId)}
            </button>
            {d.decision || d.content || JSON.stringify(d)}
          </div>
        {/each}
      </div>
    </div>
  </div>
  <div class="w-50 flex-1 card bg-base-100">
    <div class="card-body p-4 overflow-hidden">
      <h3 class="card-title text-sm mb-2">主 Agent 对话历史</h3>
      <div class="space-y-1 overflow-y-auto max-h-[60vh] font-mono text-xs">
        {#each history as msg}
          {@const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}
          <div class="codeact-msg role-{msg.role}">
            <span class="role-label">{msg.role}</span>
            <div class="whitespace-pre-wrap mt-1 text-xs">{escapeHtml(content).slice(0, 2000)}</div>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
.decision-item { padding: 0.25rem 0.5rem; border-radius: 0.25rem; }
.decision-item:nth-child(odd) { background: var(--color-base-200); }
</style>
