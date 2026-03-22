<script>
  import { api } from '../../lib/api.js';
  import { shortId, escapeHtml, getPlatform, platformLabel, stripPlatform } from '../../lib/utils.js';

  let chatIdInput = '';
  let profiles = [];

  export async function load() {
    if (!chatIdInput.trim()) { alert('请输入 chatId'); return; }
    profiles = await api(`/memory/profiles/${chatIdInput.trim()}`);
  }

  function editProfile(userId, chatId) {
    window.dispatchEvent(new CustomEvent('memoryEdit', { detail: { type: 'profile', userId, chatId } }));
  }

  async function deleteProfile(userId, chatId) {
    if (!confirm(`确认删除 ${userId} 在 ${shortId(chatId)} 的画像？`)) return;
    await api(`/memory/profile/${userId}/${chatId}`, { method: 'DELETE' });
    load();
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">群内画像 (PersonGroupProfile)</h3>
      <div class="flex gap-2 items-center">
        <input type="text" placeholder="输入 chatId 查询" class="input input-sm input-bordered w-48"
               bind:value={chatIdInput} onkeydown={(e) => e.key === 'Enter' && load()} />
        <button class="btn btn-xs btn-primary" onclick={load}>查询</button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>UserId</th><th>ChatId</th><th>邓巴层</th><th>Traits</th><th>Interests</th><th>消息数</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !profiles.length}
            <tr><td colspan="7" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each profiles as p}
              <tr>
                <td class="font-mono text-xs">
                  {#if getPlatform(p.userId)}<span class="platform-badge platform-{getPlatform(p.userId)}">{platformLabel(getPlatform(p.userId))}</span>{/if}
                  {stripPlatform(p.userId)}
                </td>
                <td class="font-mono text-xs">
                  {#if getPlatform(p.chatId)}<span class="platform-badge platform-{getPlatform(p.chatId)}">{platformLabel(getPlatform(p.chatId))}</span>{/if}
                  {shortId(p.chatId)}
                </td>
                <td><span class="badge badge-xs">T{p.dunbarTier}</span></td>
                <td class="max-w-32 truncate" title={(p.traits || []).join(', ')}>{(p.traits || []).join(', ') || '-'}</td>
                <td class="max-w-32 truncate" title={(p.interests || []).join(', ')}>{(p.interests || []).join(', ') || '-'}</td>
                <td>{p.messageCount}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" onclick={() => editProfile(p.userId, p.chatId)}>✏️</button>
                    <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteProfile(p.userId, p.chatId)}>🗑</button>
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
