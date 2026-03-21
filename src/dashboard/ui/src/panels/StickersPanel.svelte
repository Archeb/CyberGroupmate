<script>
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { escapeHtml } from '../lib/utils.js';

  let stickers = [];
  let editId = '';
  let editEmoji = '';
  let editDesc = '';
  let editModal;

  $: if ($activeTab === 'stickers') loadStickers();

  async function loadStickers() {
    stickers = await api('/stickers');
  }

  async function deleteSticker(uniqueFileId) {
    if (!confirm(`确认删除贴纸 ${uniqueFileId.slice(-16)} 的缓存？`)) return;
    await api(`/stickers/${encodeURIComponent(uniqueFileId)}`, { method: 'DELETE' });
    loadStickers();
  }

  function editSticker(uniqueFileId) {
    const s = stickers.find(s => s.uniqueFileId === uniqueFileId);
    if (!s) return;
    editId = uniqueFileId;
    editEmoji = s.emoji || '';
    editDesc = s.description || '';
    editModal.showModal();
  }

  async function saveSticker() {
    if (!editDesc.trim()) { alert('描述不能为空'); return; }
    await api(`/stickers/${encodeURIComponent(editId)}`, {
      method: 'PUT',
      body: { description: editDesc.trim(), emoji: editEmoji.trim() || undefined },
    });
    editModal.close();
    loadStickers();
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-3">
      <h3 class="card-title text-sm">🎭 贴纸描述缓存</h3>
      <div class="flex gap-2 items-center">
        <span class="badge badge-sm badge-ghost">{stickers.length}</span>
        <button class="btn btn-xs btn-primary" onclick={loadStickers}>刷新</button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>Emoji</th><th>描述</th><th>UniqueFileId</th><th>创建时间</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !stickers.length}
            <tr><td colspan="5" class="text-center opacity-60">暂无贴纸缓存</td></tr>
          {:else}
            {#each stickers as s}
              <tr>
                <td class="text-xl">{s.emoji || '-'}</td>
                <td class="max-w-xs truncate" title={s.description}>{s.description}</td>
                <td class="font-mono text-xs max-w-32 truncate" title={s.uniqueFileId}>{s.uniqueFileId.slice(-16)}</td>
                <td class="text-xs opacity-60">{s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" onclick={() => editSticker(s.uniqueFileId)}>✏️</button>
                    <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteSticker(s.uniqueFileId)}>🗑</button>
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

<!-- Sticker Edit Modal -->
<dialog bind:this={editModal} class="modal">
  <div class="modal-box">
    <h3 class="text-lg font-bold">编辑贴纸描述</h3>
    <div class="py-4 space-y-3">
      <div class="text-xs opacity-60">UniqueFileId: <span class="font-mono">{editId}</span></div>
      <input type="text" placeholder="Emoji" class="input input-bordered w-full" maxlength="8" bind:value={editEmoji} />
      <textarea placeholder="描述" class="textarea textarea-bordered w-full" rows="3" bind:value={editDesc}></textarea>
    </div>
    <div class="modal-action">
      <button class="btn btn-primary" onclick={saveSticker}>保存</button>
      <form method="dialog"><button class="btn">取消</button></form>
    </div>
  </div>
</dialog>
