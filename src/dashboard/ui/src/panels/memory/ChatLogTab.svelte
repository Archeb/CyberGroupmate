<script>
  import { activeMemoryTab, activeTab, pendingMemoryLink } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { shortId, getPlatform, platformLabel, stripPlatform } from '../../lib/utils.js';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';

  let chatIdInput = '';
  let userIdInput = '';
  let keywordInput = '';
  let items = [];
  let total = 0;
  let page = 0;
  let selectedIds = new Set();
  let selectAll = false;
  let loading = false;

  onMount(() => {
    const pending = get(pendingMemoryLink);
    if (pending?.tab === 'm-chatlog') {
      if (pending.chatId) chatIdInput = pending.chatId;
      if (pending.userId) userIdInput = pending.userId;
      pendingMemoryLink.set(null);
      if (chatIdInput || userIdInput) load();
    }
  });

  async function load(p) {
    if (p !== undefined) page = p;
    if (!chatIdInput.trim() && !userIdInput.trim() && !keywordInput.trim()) {
      alert('请至少输入一个筛选条件');
      return;
    }
    loading = true;
    selectedIds = new Set();
    selectAll = false;
    try {
      const params = new URLSearchParams();
      if (chatIdInput.trim()) params.set('chatId', chatIdInput.trim());
      if (userIdInput.trim()) params.set('userId', userIdInput.trim());
      if (keywordInput.trim()) params.set('keyword', keywordInput.trim());
      params.set('limit', '50');
      params.set('offset', String(page * 50));
      const data = await api(`/memory/messages?${params}`);
      items = data.items || [];
      total = data.total || 0;
    } finally {
      loading = false;
    }
  }

  function toggleSelect(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    selectedIds = new Set(selectedIds);
    selectAll = selectedIds.size === items.length;
  }

  function toggleSelectAll() {
    if (selectAll) {
      selectedIds = new Set();
      selectAll = false;
    } else {
      selectedIds = new Set(items.map(m => m.messageId));
      selectAll = true;
    }
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    const chatId = items.find(m => selectedIds.has(m.messageId))?.chatId;
    if (!chatId) return;
    if (!confirm(`确认删除 ${selectedIds.size} 条消息？`)) return;
    await api('/memory/messages', {
      method: 'DELETE',
      body: { chatId, messageIds: [...selectedIds] }
    });
    selectedIds = new Set();
    selectAll = false;
    load();
  }

  function editMessage(m) {
    window.dispatchEvent(new CustomEvent('memoryEdit', {
      detail: { type: 'message', chatId: m.chatId, messageId: m.messageId, text: m.text, displayName: m.displayName }
    }));
  }

  function jumpToPersons(userId) {
    activeMemoryTab.set('m-persons');
  }

  function jumpToProfiles(userId, chatId) {
    pendingMemoryLink.set({ tab: 'm-profiles', chatId });
    activeMemoryTab.set('m-profiles');
  }

  export function refresh() { if (items.length > 0) load(); }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2 flex-wrap gap-2">
      <h3 class="card-title text-sm">聊天记录 (MessageLog)</h3>
      <div class="flex gap-2 items-center flex-wrap">
        <input type="text" placeholder="chatId" class="input input-sm input-bordered w-40"
               bind:value={chatIdInput} onkeydown={(e) => e.key === 'Enter' && load(0)} />
        <input type="text" placeholder="userId" class="input input-sm input-bordered w-36"
               bind:value={userIdInput} onkeydown={(e) => e.key === 'Enter' && load(0)} />
        <input type="text" placeholder="关键词" class="input input-sm input-bordered w-32"
               bind:value={keywordInput} onkeydown={(e) => e.key === 'Enter' && load(0)} />
        <button class="btn btn-xs btn-primary" onclick={() => load(0)}>查询</button>
        <span class="badge badge-sm badge-ghost">{total}</span>
      </div>
    </div>

    {#if selectedIds.size > 0}
      <div class="flex items-center gap-2 mb-2 p-2 bg-base-200 rounded-lg">
        <span class="text-sm">已选 {selectedIds.size} 条</span>
        <button class="btn btn-xs btn-error" onclick={deleteSelected}>
          <i class="fa-solid fa-trash-can"></i> 批量删除
        </button>
      </div>
    {/if}

    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th><input type="checkbox" class="checkbox checkbox-xs" checked={selectAll} onchange={toggleSelectAll} /></th>
          <th>时间</th><th>ChatId</th><th>UserId</th><th>显示名</th><th>文本</th><th>媒体</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if loading}
            <tr><td colspan="8" class="text-center opacity-60">加载中...</td></tr>
          {:else if !items.length}
            <tr><td colspan="8" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each items as m}
              <tr class:bg-base-200={selectedIds.has(m.messageId)}>
                <td><input type="checkbox" class="checkbox checkbox-xs" checked={selectedIds.has(m.messageId)} onchange={() => toggleSelect(m.messageId)} /></td>
                <td class="text-xs opacity-60 whitespace-nowrap">{m.timestamp ? new Date(m.timestamp).toLocaleString() : '-'}</td>
                <td class="font-mono text-xs" title={m.chatId}>
                  {#if getPlatform(m.chatId)}<span class="platform-badge platform-{getPlatform(m.chatId)}" style="font-size:0.5rem">{platformLabel(getPlatform(m.chatId))}</span>{/if}
                  {shortId(m.chatId)}
                </td>
                <td class="font-mono text-xs">
                  <button class="clickable-link" onclick={() => jumpToPersons(m.userId)}>{stripPlatform(m.userId)}</button>
                </td>
                <td class="text-xs">{m.displayName || '-'}</td>
                <td class="max-w-64 truncate text-xs" title={m.text || ''}>{(m.text || '').slice(0, 200)}</td>
                <td class="text-xs opacity-60">{m.mediaType || '-'}</td>
                <td>
                  <button class="btn btn-xs btn-ghost" onclick={() => editMessage(m)}><i class="fa-solid fa-pen-to-square"></i></button>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>

    {#if Math.ceil(total / 50) > 1}
      <div class="flex justify-center mt-2 gap-2 flex-wrap">
        {#if page > 0}
          <button class="btn btn-xs btn-ghost" onclick={() => load(page - 1)}>← 上一页</button>
        {/if}
        <span class="text-xs opacity-60 self-center">第 {page + 1} / {Math.ceil(total / 50)} 页</span>
        {#if page < Math.ceil(total / 50) - 1}
          <button class="btn btn-xs btn-ghost" onclick={() => load(page + 1)}>下一页 →</button>
        {/if}
      </div>
    {/if}
  </div>
</div>
