<script>
  import { topicDetailId, activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { escapeHtml, getGroupLabel } from '../lib/utils.js';

  let data = null;
  let loading = false;

  $: if ($topicDetailId && $activeTab === 'topic-detail') loadDetail($topicDetailId);

  async function loadDetail(topicId) {
    loading = true;
    data = null;
    try {
      data = await api(`/topic/${topicId}`);
    } catch (err) {
      data = { error: String(err) };
    }
    loading = false;
  }

  function quickQueryUser(userId, chatId) {
    activeTab.set('memory');
    window.dispatchEvent(new CustomEvent('quickQueryUser', { detail: { userId, chatId } }));
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    {#if loading}
      <h3 class="card-title text-sm">加载中...</h3>
    {:else if data?.error}
      <h3 class="card-title text-sm">加载失败</h3>
      <div class="text-error text-xs">{data.error}</div>
    {:else if data}
      <div class="flex justify-between items-center mb-3">
        <h3 class="card-title text-sm">📖 {data.label || $topicDetailId}</h3>
        <div class="flex gap-2">
          <span class="badge">{data.state || ''}</span>
          <span class="text-xs opacity-60">{(data.startedAt || '').slice(0, 16)} ~ {(data.endedAt || '进行中').slice(0, 16)}</span>
        </div>
      </div>

      <div class="mb-3 text-xs space-y-1">
        {#if data.summary}
          <div class="p-2 bg-base-200 rounded"><strong>摘要：</strong>{data.summary}</div>
        {/if}
        <div><strong>话题 ID：</strong><span class="font-mono">{data.topicId}</span></div>
        {#if data.chatId}<div><strong>群组：</strong>{getGroupLabel(data.chatId)}</div>{/if}
        <div><strong>消息数：</strong>{data.messageCount || 0}</div>
        {#if data.sentiment}<div><strong>情感：</strong>{data.sentiment}</div>{/if}
        {#if data.wasEngaged}<div><strong>已回应：</strong>×{data.interventionCount || 1}</div>{/if}
        {#if data.keywords?.length}
          <div><strong>关键词：</strong>{#each data.keywords as k}<span class="badge badge-xs mr-1">{k}</span>{/each}</div>
        {/if}
        {#if data.participants?.length}
          <div><strong>参与者：</strong>
            {#each data.participants as p, i}
              {#if i > 0}, {/if}
              <button class="clickable-link" onclick={() => quickQueryUser(p, data.chatId || '')}>{p}</button>
            {/each}
          </div>
        {/if}
        {#if data.keyPoints?.length}
          <div><strong>要点：</strong>
            <ul class="list-disc ml-4">{#each data.keyPoints as kp}<li>{kp}</li>{/each}</ul>
          </div>
        {/if}
      </div>

      <div class="divider text-xs">相关消息</div>
      <div class="overflow-y-auto max-h-[55vh] space-y-1 font-mono text-xs">
        {#if !(data.messages || []).length}
          <span class="opacity-60">无相关消息</span>
        {:else}
          {#each data.messages as m}
            <div class="msg-item">
              <span class="msg-time">{m.timestamp ? m.timestamp.slice(11, 19) : ''}</span>
              <button class="msg-user clickable-link" onclick={() => quickQueryUser(m.userId || '', data.chatId || '')}>
                {m.displayName || m.userId || '?'}
              </button>
              <span class="msg-text">{m.text || ''}</span>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <span class="opacity-60">选择话题以查看详情</span>
    {/if}
  </div>
</div>
