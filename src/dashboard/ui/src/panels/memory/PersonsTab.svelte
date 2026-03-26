<script>
  import { activeMemoryTab, activeTab, pendingMemoryLink } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { escapeHtml, getPlatform, platformLabel, stripPlatform } from '../../lib/utils.js';

  let items = [];
  let total = 0;
  let page = 0;

  $: if ($activeTab === 'memory' && $activeMemoryTab === 'm-persons') load();

  async function load(p) {
    if (p !== undefined) page = p;
    const data = await api(`/memory/persons?limit=50&offset=${page * 50}`);
    items = data.items || [];
    total = data.total || 0;
  }

  function editPerson(userId) {
    window.dispatchEvent(new CustomEvent('memoryEdit', { detail: { type: 'person', userId } }));
  }

  async function deletePerson(userId) {
    if (!confirm(`确认删除用户画像 ${userId}？`)) return;
    await api(`/memory/person/${userId}`, { method: 'DELETE' });
    load();
  }

  function jumpToProfiles(userId) {
    pendingMemoryLink.set({ tab: 'm-profiles', userId });
    activeMemoryTab.set('m-profiles');
  }

  function jumpToChatLog(userId) {
    pendingMemoryLink.set({ tab: 'm-chatlog', userId });
    activeMemoryTab.set('m-chatlog');
  }

  function jumpToFacts(userId) {
    pendingMemoryLink.set({ tab: 'm-facts', subject: userId });
    activeMemoryTab.set('m-facts');
  }

  export function refresh() { load(); }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">用户画像 (PersonIdentity)</h3>
      <div class="flex gap-2 items-center">
        <span class="badge badge-sm badge-ghost">{total}</span>
        <button class="btn btn-xs btn-primary" onclick={() => load()}>刷新</button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>UserId</th><th>显示名</th><th>Username</th><th>别名</th><th>消息数</th><th>最后活跃</th><th>首次出现</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !items.length}
            <tr><td colspan="8" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each items as p}
              <tr>
                <td class="font-mono text-xs">
                  {#if getPlatform(p.userId)}<span class="platform-badge platform-{getPlatform(p.userId)}">{platformLabel(getPlatform(p.userId))}</span>{/if}
                  {stripPlatform(p.userId)}
                </td>
                <td>{p.displayName}</td>
                <td class="text-xs opacity-70">{p.username ? `@${p.username}` : '-'}</td>
                <td class="max-w-32 truncate" title={(p.aliases || []).join(', ')}>{(p.aliases || []).join(', ') || '-'}</td>
                <td>{p.totalMessageCount}</td>
                <td class="text-xs opacity-60">{p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : '-'}</td>
                <td class="text-xs opacity-60">{p.firstSeenAt ? new Date(p.firstSeenAt).toLocaleString() : '-'}</td>
                <td>
                  <div class="flex gap-1">
                    <div class="dropdown dropdown-end">
                      <button tabindex="0" class="btn btn-xs btn-ghost" title="关联查询"><i class="fa-solid fa-link"></i></button>
                      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                      <ul tabindex="0" class="dropdown-content menu menu-xs bg-base-200 rounded-box shadow-lg z-50 w-36">
                        <li><button onclick={() => jumpToProfiles(p.userId)}>群内画像</button></li>
                        <li><button onclick={() => jumpToFacts(p.userId)}>核心事实</button></li>
                        <li><button onclick={() => jumpToChatLog(p.userId)}>聊天记录</button></li>
                      </ul>
                    </div>
                    <button class="btn btn-xs btn-ghost" onclick={() => editPerson(p.userId)}><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="btn btn-xs btn-ghost text-error" onclick={() => deletePerson(p.userId)}><i class="fa-solid fa-trash-can"></i></button>
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if Math.ceil(total / 50) > 1}
      <div class="flex justify-center mt-2 gap-2">
        {#each Array.from({ length: Math.min(Math.ceil(total / 50), 10) }) as _, i}
          <button class="btn btn-xs" class:btn-primary={i === page} class:btn-ghost={i !== page}
                  onclick={() => load(i)}>{i + 1}</button>
        {/each}
      </div>
    {/if}
  </div>
</div>
