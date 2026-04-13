<script>
  import { activeTab } from '../lib/stores.js';
  import { api, apiBase } from '../lib/api.js';

  let stickers = [];
  let editId = '';
  let editEmoji = '';
  let editDesc = '';
  let editModal;

  // 全局 sticker 发送模式（从 config 中读取）
  let stickerSendingMode = 'allow_all';
  let loadingConfig = false;

  $: if ($activeTab === 'stickers') {
    loadStickers();
    loadStickerMode();
  }

  async function loadStickers() {
    stickers = await api('/stickers');
  }

  async function loadStickerMode() {
    try {
      const cfg = await api('/config');
      stickerSendingMode = cfg?.vision?.stickerSendingMode || 'allow_all';
    } catch { /* ignore */ }
  }

  async function saveStickerMode() {
    loadingConfig = true;
    try {
      const cfg = await api('/config');
      if (!cfg.vision) cfg.vision = {};
      cfg.vision.stickerSendingMode = stickerSendingMode;
      await api('/config', { method: 'PUT', body: cfg });
    } catch (err) {
      alert('保存失败: ' + err);
    } finally {
      loadingConfig = false;
    }
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

  async function toggleStickerEnabled(uniqueFileId, enabled) {
    await api(`/stickers/${encodeURIComponent(uniqueFileId)}/enabled`, {
      method: 'PATCH',
      body: { enabled },
    });
    // 更新本地状态
    const s = stickers.find(s => s.uniqueFileId === uniqueFileId);
    if (s) s.enabled = enabled;
    stickers = stickers;
  }

  function getStickerImageUrl(uniqueFileId) {
    return apiBase(`/stickers/${encodeURIComponent(uniqueFileId)}/image`);
  }

  $: enabledCount = stickers.filter(s => s.enabled).length;
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <!-- 全局 Sticker 发送模式 -->
    <div class="flex flex-wrap items-center gap-3 mb-4 p-3 bg-base-200 rounded-lg">
      <span class="text-sm font-bold whitespace-nowrap">
        <i class="fa-solid fa-sliders opacity-50 mr-1"></i>贴纸发送策略
      </span>
      <div class="flex gap-1">
        <label class="btn btn-xs" class:btn-primary={stickerSendingMode === 'allow_all'} class:btn-ghost={stickerSendingMode !== 'allow_all'}>
          <input type="radio" class="hidden" bind:group={stickerSendingMode} value="allow_all" on:change={saveStickerMode} />
          全部允许
        </label>
        <label class="btn btn-xs" class:btn-warning={stickerSendingMode === 'allow_listed'} class:btn-ghost={stickerSendingMode !== 'allow_listed'}>
          <input type="radio" class="hidden" bind:group={stickerSendingMode} value="allow_listed" on:change={saveStickerMode} />
          仅指定
        </label>
        <label class="btn btn-xs" class:btn-error={stickerSendingMode === 'disallow_all'} class:btn-ghost={stickerSendingMode !== 'disallow_all'}>
          <input type="radio" class="hidden" bind:group={stickerSendingMode} value="disallow_all" on:change={saveStickerMode} />
          全部禁止
        </label>
      </div>
      {#if stickerSendingMode === 'allow_listed'}
        <span class="text-xs opacity-60">已启用 {enabledCount}/{stickers.length}</span>
      {/if}
      {#if loadingConfig}
        <span class="loading loading-spinner loading-xs"></span>
      {/if}
    </div>

    <div class="flex justify-between items-center mb-3 sticker-header">
      <h3 class="card-title text-sm">🎭 贴纸描述缓存</h3>
      <div class="flex gap-2 items-center">
        <span class="badge badge-sm badge-ghost">{stickers.length}</span>
        <button class="btn btn-xs btn-primary" on:click={loadStickers}>刷新</button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          {#if stickerSendingMode === 'allow_listed'}
            <th>启用</th>
          {/if}
          <th>预览</th><th>Emoji</th><th>描述</th><th class="hide-mobile">UniqueFileId</th><th class="hide-mobile">创建时间</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !stickers.length}
            <tr><td colspan={stickerSendingMode === 'allow_listed' ? 7 : 6} class="text-center opacity-60">暂无贴纸缓存</td></tr>
          {:else}
            {#each stickers as s}
              <tr class:opacity-40={stickerSendingMode === 'allow_listed' && !s.enabled}>
                {#if stickerSendingMode === 'allow_listed'}
                  <td>
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs checkbox-primary"
                      checked={s.enabled}
                      on:change={() => toggleStickerEnabled(s.uniqueFileId, !s.enabled)}
                    />
                  </td>
                {/if}
                <td>
                  {#if s.hasImage}
                    <img
                      src={getStickerImageUrl(s.uniqueFileId)}
                      alt={s.emoji || '贴纸'}
                      class="sticker-thumb"
                      loading="lazy"
                    />
                  {:else}
                    <span class="text-xs opacity-40">-</span>
                  {/if}
                </td>
                <td class="text-xl">{s.emoji || '-'}</td>
                <td class="max-w-xs truncate" title={s.description}>{s.description}</td>
                <td class="font-mono text-xs max-w-32 truncate hide-mobile" title={s.uniqueFileId}>{s.uniqueFileId.slice(-16)}</td>
                <td class="text-xs opacity-60 hide-mobile">{s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" on:click={() => editSticker(s.uniqueFileId)}>✏️</button>
                    <button class="btn btn-xs btn-ghost text-error" on:click={() => deleteSticker(s.uniqueFileId)}>🗑</button>
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
      <button class="btn btn-primary" on:click={saveSticker}>保存</button>
      <form method="dialog"><button class="btn">取消</button></form>
    </div>
  </div>
</dialog>

<style>
  .sticker-thumb {
    width: 48px;
    height: 48px;
    object-fit: contain;
    border-radius: 4px;
    background: transparent;
  }

  @media (max-width: 768px) {
    .sticker-header { flex-wrap: wrap; gap: 0.5rem; }
    .sticker-thumb { width: 36px; height: 36px; }
  }
</style>
