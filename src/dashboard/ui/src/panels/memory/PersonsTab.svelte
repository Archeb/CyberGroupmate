<script>
  import { activeMemoryTab, activeTab } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { escapeHtml } from '../../lib/utils.js';

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
          <th>UserId</th><th>显示名</th><th>别名</th><th>消息数</th><th>最后活跃</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !items.length}
            <tr><td colspan="6" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each items as p}
              <tr>
                <td class="font-mono text-xs">{p.userId}</td>
                <td>{p.displayName}</td>
                <td class="max-w-32 truncate" title={(p.aliases || []).join(', ')}>{(p.aliases || []).join(', ') || '-'}</td>
                <td>{p.totalMessageCount}</td>
                <td class="text-xs opacity-60">{p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : '-'}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" onclick={() => editPerson(p.userId)}>✏️</button>
                    <button class="btn btn-xs btn-ghost text-error" onclick={() => deletePerson(p.userId)}>🗑</button>
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
