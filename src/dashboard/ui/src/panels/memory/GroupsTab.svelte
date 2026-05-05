<script>
  import { activeTab, activeMemoryTab, pendingMemoryLink } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { shortId, escapeHtml, getPlatform, platformLabel, getChatTypeLabel } from '../../lib/utils.js';

  let groups = [];
  let filterType = 'all'; // 'all' | 'group' | 'dm'
  let filterPlatform = 'all'; // 'all' | 'telegram' | 'onebot' | 'discord'
  let searchQuery = '';

  $: if ($activeTab === 'memory' && $activeMemoryTab === 'm-groups') load();

  $: filtered = groups.filter(g => {
    // 类型筛选
    if (filterType === 'group' && g.isDirectMessage) return false;
    if (filterType === 'dm' && !g.isDirectMessage) return false;
    // 平台筛选
    if (filterPlatform !== 'all') {
      const platform = getPlatform(g.chatId);
      if (platform !== filterPlatform) return false;
    }
    // 搜索
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const title = (g.chatTitle || '').toLowerCase();
      const chatId = (g.chatId || '').toLowerCase();
      const desc = (g.description || '').toLowerCase();
      if (!title.includes(q) && !chatId.includes(q) && !desc.includes(q)) return false;
    }
    return true;
  });

  // 统计
  $: stats = {
    total: groups.length,
    groups: groups.filter(g => !g.isDirectMessage).length,
    dms: groups.filter(g => g.isDirectMessage).length,
    platforms: [...new Set(groups.map(g => getPlatform(g.chatId)).filter(Boolean))],
  };

  async function load() {
    groups = await api('/memory/groups');
  }

  function editGroup(chatId) {
    window.dispatchEvent(new CustomEvent('memoryEdit', { detail: { type: 'group', chatId } }));
  }

  function jumpToProfiles(chatId) {
    pendingMemoryLink.set({ tab: 'm-profiles', chatId });
    activeMemoryTab.set('m-profiles');
  }

  function jumpToChatLog(chatId) {
    pendingMemoryLink.set({ tab: 'm-chatlog', chatId });
    activeMemoryTab.set('m-chatlog');
  }

  function clearFilters() {
    filterType = 'all';
    filterPlatform = 'all';
    searchQuery = '';
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">群组画像 (GroupModel)</h3>
      <div class="flex items-center gap-2">
        <span class="badge badge-sm badge-ghost">{stats.total} 条</span>
        <button class="btn btn-xs btn-primary" onclick={load}>刷新</button>
      </div>
    </div>

    <!-- 筛选控件 -->
    <div class="flex flex-wrap items-center gap-2 mb-3 p-2 bg-base-200 rounded-lg">
      <!-- 类型筛选 -->
      <div class="join">
        <button class="btn btn-xs join-item" class:btn-active={filterType === 'all'} onclick={() => filterType = 'all'}>
          全部 ({stats.total})
        </button>
        <button class="btn btn-xs join-item" class:btn-active={filterType === 'group'} onclick={() => filterType = 'group'}>
          群聊 ({stats.groups})
        </button>
        <button class="btn btn-xs join-item" class:btn-active={filterType === 'dm'} onclick={() => filterType = 'dm'}>
          私聊 ({stats.dms})
        </button>
      </div>

      <!-- 平台筛选 -->
      <div class="join">
        <button class="btn btn-xs join-item" class:btn-active={filterPlatform === 'all'} onclick={() => filterPlatform = 'all'}>
          全部平台
        </button>
        {#each stats.platforms as p}
          <button class="btn btn-xs join-item" class:btn-active={filterPlatform === p} onclick={() => filterPlatform = p}>
            {platformLabel(p)}
          </button>
        {/each}
      </div>

      <!-- 搜索框 -->
      <div class="flex-1 min-w-[120px]">
        <input
          type="text"
          placeholder="搜索标题/ID/描述..."
          class="input input-xs input-bordered w-full"
          bind:value={searchQuery}
        />
      </div>

      <!-- 清除筛选 -->
      {#if filterType !== 'all' || filterPlatform !== 'all' || searchQuery}
        <button class="btn btn-xs btn-ghost" onclick={clearFilters}>
          <i class="fa-solid fa-xmark"></i> 清除
        </button>
      {/if}
    </div>

    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>ChatId</th><th>类型</th><th>标题</th><th>描述</th><th>角色</th><th>参与度</th><th>活跃人数</th><th>日均消息</th><th>热门话题</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !filtered.length}
            <tr><td colspan="10" class="text-center opacity-60">
              {groups.length ? '无匹配结果' : '暂无数据'}
            </td></tr>
          {:else}
            {#each filtered as g}
              {@const chatType = getChatTypeLabel(g.chatId) || (g.isDirectMessage ? '私聊' : '群聊')}
              <tr>
                <td class="font-mono text-xs" title={g.chatId}>
                  {#if getPlatform(g.chatId)}<span class="platform-badge platform-{getPlatform(g.chatId)}">{platformLabel(getPlatform(g.chatId))}</span>{/if}
                  {shortId(g.chatId)}
                </td>
                <td>
                  <span class="badge badge-xs {g.isDirectMessage ? 'badge-ghost' : 'badge-primary'}">{chatType}</span>
                </td>
                <td>
                  <span class="cursor-pointer hover:underline" title="点击编辑" onclick={() => editGroup(g.chatId)}>
                    {g.chatTitle || '-'}
                  </span>
                </td>
                <td class="max-w-40 truncate" title={g.description || ''}>{g.description || '-'}</td>
                <td class="max-w-24 truncate" title={g.agentRole || ''}>{g.agentRole || '-'}</td>
                <td>
                  {#if g.engagementLevel}
                    <span class="badge badge-xs" class:badge-success={g.engagementLevel==='high'} class:badge-warning={g.engagementLevel==='medium'} class:badge-ghost={g.engagementLevel==='low'}>
                      {g.engagementLevel}
                    </span>
                  {:else}
                    -
                  {/if}
                </td>
                <td>{g.activeMembers ?? '-'}</td>
                <td>{g.avgMessagesPerDay != null ? g.avgMessagesPerDay.toFixed(1) : '-'}</td>
                <td class="max-w-32 truncate" title={(g.hotTopics || []).join(', ')}>{(g.hotTopics || []).join(', ') || '-'}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" title="群内画像列表" onclick={() => jumpToProfiles(g.chatId)}><i class="fa-solid fa-id-badge"></i></button>
                    <button class="btn btn-xs btn-ghost" title="聊天记录" onclick={() => jumpToChatLog(g.chatId)}><i class="fa-solid fa-comments"></i></button>
                    <button class="btn btn-xs btn-ghost" title="编辑群组" onclick={() => editGroup(g.chatId)}><i class="fa-solid fa-pen-to-square"></i></button>
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>
</div>
