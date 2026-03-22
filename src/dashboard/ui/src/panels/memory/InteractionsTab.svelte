<script>
  import { api } from '../../lib/api.js';
  import { shortId, escapeHtml, getPlatform, platformLabel, stripPlatform } from '../../lib/utils.js';

  let items = [];
  let total = 0;
  let page = 0;
  let chatIdFilter = '';
  let userIdFilter = '';

  async function load(p) {
    if (p !== undefined) page = p;
    let url = `/memory/interactions?limit=50&offset=${page * 50}`;
    if (chatIdFilter) url += `&chatId=${encodeURIComponent(chatIdFilter)}`;
    if (userIdFilter) url += `&userId=${encodeURIComponent(userIdFilter)}`;
    const data = await api(url);
    items = data.items || [];
    total = data.total || 0;
  }

  async function deleteInteraction(id) {
    if (!confirm('确认删除此交互记录？')) return;
    await api(`/memory/interaction/${id}`, { method: 'DELETE' });
    load();
  }

  export function refresh() { load(); }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">交互日志 (Interaction)</h3>
      <div class="flex gap-2 items-center">
        <input type="text" placeholder="ChatId" class="input input-sm input-bordered w-36" bind:value={chatIdFilter} />
        <input type="text" placeholder="UserId" class="input input-sm input-bordered w-36" bind:value={userIdFilter} />
        <button class="btn btn-xs btn-primary" onclick={() => load()}>查询</button>
        <span class="badge badge-sm badge-ghost">{total}</span>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>时间</th><th>ChatId</th><th>UserId</th><th>类型</th><th>摘要</th><th>情感</th><th>重要性</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !items.length}
            <tr><td colspan="8" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each items as i}
              <tr>
                <td class="text-xs opacity-60">{i.date ? new Date(i.date).toLocaleString() : '-'}</td>
                <td class="font-mono text-xs">
                  {#if getPlatform(i.chatId)}<span class="platform-badge platform-{getPlatform(i.chatId)}">{platformLabel(getPlatform(i.chatId))}</span>{/if}
                  {shortId(i.chatId)}
                </td>
                <td class="font-mono text-xs">
                  {#if getPlatform(i.userId)}<span class="platform-badge platform-{getPlatform(i.userId)}">{platformLabel(getPlatform(i.userId))}</span>{/if}
                  {stripPlatform(i.userId)}
                </td>
                <td><span class="badge badge-xs">{i.type}</span></td>
                <td class="max-w-64 truncate" title={i.summary}>{i.summary}</td>
                <td>{i.sentiment}</td>
                <td>{(i.significance * 100).toFixed(0)}%</td>
                <td><button class="btn btn-xs btn-ghost text-error" onclick={() => deleteInteraction(i.id)}><i class="fa-solid fa-trash-can"></i></button></td>
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
