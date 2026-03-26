<script>
  import { activeTab, activeMemoryTab, pendingMemoryLink } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { shortId, escapeHtml, getPlatform, platformLabel } from '../../lib/utils.js';

  let groups = [];

  $: if ($activeTab === 'memory' && $activeMemoryTab === 'm-groups') load();

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
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">群组画像 (GroupModel)</h3>
      <button class="btn btn-xs btn-primary" onclick={load}>刷新</button>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>ChatId</th><th>标题</th><th>描述</th><th>角色</th><th>参与度</th><th>活跃人数</th><th>日均消息</th><th>私聊</th><th>热门话题</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !groups.length}
            <tr><td colspan="10" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each groups as g}
              <tr>
                <td class="font-mono text-xs" title={g.chatId}>
                  {#if getPlatform(g.chatId)}<span class="platform-badge platform-{getPlatform(g.chatId)}">{platformLabel(getPlatform(g.chatId))}</span>{/if}
                  {shortId(g.chatId)}
                </td>
                <td>{g.chatTitle || '-'}</td>
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
                <td>{g.isDirectMessage ? '✓' : '-'}</td>
                <td class="max-w-32 truncate" title={(g.hotTopics || []).join(', ')}>{(g.hotTopics || []).join(', ') || '-'}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" title="群内画像列表" onclick={() => jumpToProfiles(g.chatId)}><i class="fa-solid fa-id-badge"></i></button>
                    <button class="btn btn-xs btn-ghost" title="聊天记录" onclick={() => jumpToChatLog(g.chatId)}><i class="fa-solid fa-comments"></i></button>
                    <button class="btn btn-xs btn-ghost" onclick={() => editGroup(g.chatId)}><i class="fa-solid fa-pen-to-square"></i></button>
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
