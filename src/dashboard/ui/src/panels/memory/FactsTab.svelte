<script>
  import { activeTab, activeMemoryTab } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { escapeHtml } from '../../lib/utils.js';
  import { onMount } from 'svelte';

  let items = [];
  let total = 0;
  let page = 0;
  let subject = '';
  let category = '';

  $: if ($activeTab === 'memory' && $activeMemoryTab === 'm-facts') load();

  onMount(() => {
    function onLink(e) {
      if (e.detail?.tab !== 'm-facts') return;
      if (e.detail.subject) {
        subject = e.detail.subject;
        load();
      }
    }
    window.addEventListener('memoryLinkQuery', onLink);
    return () => window.removeEventListener('memoryLinkQuery', onLink);
  });

  async function load(p) {
    if (p !== undefined) page = p;
    let url = `/memory/facts?limit=50&offset=${page * 50}`;
    if (subject) url += `&subject=${encodeURIComponent(subject)}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;
    const data = await api(url);
    items = data.items || [];
    total = data.total || 0;
  }

  function editFact(id) {
    window.dispatchEvent(new CustomEvent('memoryEdit', { detail: { type: 'fact', id } }));
  }

  async function deleteFact(id) {
    if (!confirm('确认删除此事实？')) return;
    await api(`/memory/fact/${id}`, { method: 'DELETE' });
    load();
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">核心事实 (CoreFact)</h3>
      <div class="flex gap-2 items-center">
        <input type="text" placeholder="Subject 过滤" class="input input-sm input-bordered w-36" bind:value={subject} />
        <select class="select select-sm select-bordered w-32" bind:value={category}>
          <option value="">全部分类</option>
          <option value="biographical">biographical</option>
          <option value="preference">preference</option>
          <option value="anecdote">anecdote</option>
          <option value="opinion">opinion</option>
          <option value="plan">plan</option>
          <option value="relationship">relationship</option>
          <option value="general">general</option>
        </select>
        <button class="btn btn-xs btn-primary" onclick={() => load()}>查询</button>
        <span class="badge badge-sm badge-ghost">{total}</span>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>Subject</th><th>Category</th><th>Content</th><th>Confidence</th><th>Expires</th><th>更新时间</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !items.length}
            <tr><td colspan="7" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each items as f}
              <tr>
                <td class="font-mono text-xs max-w-24 truncate" title={f.subject}>{f.subject}</td>
                <td><span class="badge badge-xs">{f.category}</span></td>
                <td class="max-w-64 truncate" title={f.content}>{f.content}</td>
                <td>{(f.confidence * 100).toFixed(0)}%</td>
                <td class="text-xs opacity-60">{f.expiresAt ? new Date(f.expiresAt).toLocaleString() : '-'}</td>
                <td class="text-xs opacity-60">{f.updatedAt ? new Date(f.updatedAt).toLocaleString() : '-'}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" onclick={() => editFact(f.id)}><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteFact(f.id)}><i class="fa-solid fa-trash-can"></i></button>
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
