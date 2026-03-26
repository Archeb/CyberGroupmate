<script>
  import { activeMemoryTab } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { shortId, escapeHtml, getPlatform, platformLabel, stripPlatform } from '../../lib/utils.js';
  import { onMount } from 'svelte';

  let chatIdInput = '';
  let profiles = [];

  onMount(() => {
    function onLink(e) {
      if (e.detail?.tab !== 'm-profiles') return;
      if (e.detail.userId) chatIdInput = '';
      if (e.detail.chatId) chatIdInput = e.detail.chatId;
      // auto-load if we have a chatId
      if (chatIdInput) load();
    }
    window.addEventListener('memoryLinkQuery', onLink);
    return () => window.removeEventListener('memoryLinkQuery', onLink);
  });

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

  function jumpToPersons(userId) {
    activeMemoryTab.set('m-persons');
  }

  function jumpToChatLog(userId, chatId) {
    activeMemoryTab.set('m-chatlog');
    window.dispatchEvent(new CustomEvent('memoryLinkQuery', { detail: { tab: 'm-chatlog', userId, chatId } }));
  }

  /**
   * 生成 dunbar tier 的解释 tooltip
   * 算法来源: reflection.ts → computeAffinityScores → scoreToTier
   */
  function tierTooltip(p) {
    const score = p.affinityScore != null ? Math.round(p.affinityScore) : '?';
    const lines = [
      `邓巴层级 T${p.dunbarTier}（亲和度 ${score}）`,
      '',
      '分层阈值:',
      '  T1 核心 ≥ 70  (最多15人)',
      '  T2 熟悉 ≥ 40  (最多50人)',
      '  T3 认识 ≥ 15  (最多150人)',
      '  T4 陌生 < 15',
    ];
    if (p.dunbarReason) {
      lines.push('', `理由: ${p.dunbarReason}`);
    }
    return lines.join('\n');
  }

  /**
   * 生成亲和度分数的解释 tooltip
   * 算法来源: reflection.ts → computeAffinityScores
   */
  function scoreTooltip(p) {
    const score = p.affinityScore != null ? Math.round(p.affinityScore * 10) / 10 : '?';
    const lines = [
      `亲和度 ${score}/100`,
      '',
      '计算维度 (30天滚动窗口):',
      '  互动次数(DIRECT_ADDRESS) ×50%',
      '  互动天数             ×30%',
      '  画像深度(traits+interests) ×20%',
      '',
      '修正因子:',
      '  friendly +10 | dependent +15',
      '  instrumental ±0 | hostile -20',
      '',
      '时间衰减: >14天未互动 → 每天-2分',
      '',
      `消息数: ${p.messageCount ?? '?'}`,
    ];
    if (p.communicationStyle) lines.push(`沟通风格: ${p.communicationStyle}`);
    if (p.relationToAgent) lines.push(`与Agent关系: ${p.relationToAgent}`);
    return lines.join('\n');
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
          <th>UserId</th><th>ChatId</th><th>邓巴层</th><th>好感度</th><th>Traits</th><th>沟通风格</th><th>与Agent关系</th><th>消息数</th><th>最后活跃</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !profiles.length}
            <tr><td colspan="10" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each profiles as p}
              <tr>
                <td class="font-mono text-xs">
                  {#if getPlatform(p.userId)}<span class="platform-badge platform-{getPlatform(p.userId)}">{platformLabel(getPlatform(p.userId))}</span>{/if}
                  <button class="clickable-link" onclick={() => jumpToPersons(p.userId)}>{stripPlatform(p.userId)}</button>
                </td>
                <td class="font-mono text-xs">
                  {#if getPlatform(p.chatId)}<span class="platform-badge platform-{getPlatform(p.chatId)}">{platformLabel(getPlatform(p.chatId))}</span>{/if}
                  {shortId(p.chatId)}
                </td>
                <td>
                  <span class="badge badge-xs cursor-help" title={tierTooltip(p)}>T{p.dunbarTier}</span>
                </td>
                <td>
                  {#if p.affinityScore != null}
                    <span class="badge badge-xs cursor-help" class:badge-success={p.affinityScore >= 70} class:badge-warning={p.affinityScore >= 40 && p.affinityScore < 70} class:badge-ghost={p.affinityScore < 40}
                          title={scoreTooltip(p)}>
                      {Math.round(p.affinityScore)}
                    </span>
                  {:else}
                    -
                  {/if}
                </td>
                <td class="max-w-32 truncate" title={(p.traits || []).join(', ')}>{(p.traits || []).join(', ') || '-'}</td>
                <td class="text-xs max-w-24 truncate" title={p.communicationStyle || ''}>{p.communicationStyle || '-'}</td>
                <td class="text-xs max-w-24 truncate" title={p.relationToAgent || ''}>{p.relationToAgent || '-'}</td>
                <td>{p.messageCount}</td>
                <td class="text-xs opacity-60">{p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : '-'}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" title="聊天记录" onclick={() => jumpToChatLog(p.userId, p.chatId)}><i class="fa-solid fa-comments"></i></button>
                    <button class="btn btn-xs btn-ghost" onclick={() => editProfile(p.userId, p.chatId)}><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteProfile(p.userId, p.chatId)}><i class="fa-solid fa-trash-can"></i></button>
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
