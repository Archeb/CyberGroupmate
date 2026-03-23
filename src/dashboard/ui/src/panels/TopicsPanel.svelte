<script>
  import { appState, activeTab, topicDetailId } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { escapeHtml, shortId, getGroupLabel, getPlatform, platformLabel } from '../lib/utils.js';

  let topicCache = {};
  let expandedGroups = new Set();
  let searchMode = false;
  let searchQuery = '';
  let searchResults = {};

  $: groups = $appState.groups;

  async function loadTopics(chatId) {
    const data = await api(`/topics/${chatId}?limit=10&offset=0`);
    const topics = data.topics || data;
    topicCache[chatId] = {
      topics: Array.isArray(topics) ? topics : [],
      hasMore: data.hasMore ?? false,
      total: data.total ?? 0,
      offset: Array.isArray(topics) ? topics.length : 0,
    };
    topicCache = topicCache; // trigger reactivity
  }

  async function loadMore(chatId) {
    const cached = topicCache[chatId];
    if (!cached?.hasMore) return;
    const data = await api(`/topics/${chatId}?limit=10&offset=${cached.offset}`);
    const newTopics = data.topics || [];
    cached.topics.push(...newTopics);
    cached.hasMore = data.hasMore ?? false;
    cached.total = data.total ?? cached.total;
    cached.offset += newTopics.length;
    topicCache = topicCache;
  }

  function toggleGroup(chatId, open) {
    if (open) {
      expandedGroups.add(chatId);
      if (!topicCache[chatId]) loadTopics(chatId);
    } else {
      expandedGroups.delete(chatId);
    }
    expandedGroups = expandedGroups;
  }

  async function searchTopics() {
    if (!searchQuery.trim()) return;
    searchMode = true;
    searchResults = {};
    for (const g of groups) {
      try {
        const data = await api(`/topics/${g.chatId}/search?q=${encodeURIComponent(searchQuery)}`);
        const topics = data.topics || [];
        if (topics.length) searchResults[g.chatId] = topics;
      } catch { /* ignore */ }
    }
    searchResults = searchResults;
  }

  function clearSearch() {
    searchMode = false;
    searchQuery = '';
    searchResults = {};
  }

  function viewDetail(topicId) {
    topicDetailId.set(topicId);
    activeTab.set('topic-detail');
  }

  function quickQueryUser(userId, chatId) {
    activeTab.set('memory');
    window.dispatchEvent(new CustomEvent('quickQueryUser', { detail: { userId, chatId } }));
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2 topics-header">
      <h3 class="card-title text-sm">话题注册表 (TopicRegistry)</h3>
      <div class="flex gap-2 items-center">
        <input type="text" placeholder="搜索关键词..." class="input input-sm input-bordered w-48"
               bind:value={searchQuery} onkeydown={(e) => e.key === 'Enter' && searchTopics()} />
        <button class="btn btn-xs btn-primary" onclick={searchTopics}>搜索</button>
        {#if searchMode}
          <button class="btn btn-xs btn-ghost" onclick={clearSearch}>清除</button>
        {/if}
      </div>
    </div>

    <div class="space-y-2">
      {#if searchMode}
        {#each Object.entries(searchResults) as [chatId, topics]}
          <div class="collapse collapse-arrow collapse-open bg-base-200">
            <input type="checkbox" checked />
            <div class="collapse-title text-sm font-medium">
              <span class="inline-flex items-center gap-1">
                {#if getPlatform(chatId)}<span class="platform-badge platform-{getPlatform(chatId)}">{platformLabel(getPlatform(chatId))}</span>{/if}
                {getGroupLabel(chatId)}
              </span>
              <span class="badge badge-sm ml-2">{topics.length} 匹配</span>
            </div>
            <div class="collapse-content">
              <div class="space-y-1">
                {#each topics as t}
                  <div class="topic-card state-{(t.state || '').toLowerCase()}" onclick={() => viewDetail(t.id)}>
                    <div class="flex justify-between items-center">
                      <span class="font-semibold text-sm">{t.label || t.id}</span>
                      <div class="flex gap-1">
                        {#if t.wasEngaged}<span class="badge badge-xs badge-success">已回应 ×{t.interventionCount || 1}</span>{/if}
                        <span class="badge badge-xs">{t.state}</span>
                      </div>
                    </div>
                    <div class="text-xs opacity-70 mt-1">{t.summary || ''}</div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {:else}
          <div class="text-sm opacity-60">未找到匹配的话题</div>
        {/each}
      {:else if !groups.length}
        <div class="text-sm opacity-60">暂无数据</div>
      {:else}
        {#each groups as g}
          {@const cached = topicCache[g.chatId]}
          {@const isExpanded = expandedGroups.has(g.chatId)}
          <div class="collapse collapse-arrow bg-base-200">
            <input type="checkbox" checked={isExpanded} onchange={(e) => toggleGroup(g.chatId, e.target.checked)} />
            <div class="collapse-title text-sm font-medium flex justify-between items-center">
              <span class="inline-flex items-center gap-1">
                {#if getPlatform(g.chatId)}<span class="platform-badge platform-{getPlatform(g.chatId)}">{platformLabel(getPlatform(g.chatId))}</span>{/if}
                {getGroupLabel(g.chatId)}
              </span>
              <span class="badge badge-sm">
                {cached ? `${cached.topics.length}${cached.hasMore ? '+' : ''} / ${cached.total || '?'}` : g.topicCount} 话题
              </span>
            </div>
            <div class="collapse-content">
              {#if cached}
                {#if !cached.topics.length}
                  <div class="text-sm opacity-60">无话题</div>
                {:else}
                  <div class="space-y-1">
                    {#each cached.topics as t}
                      <div class="topic-card state-{(t.state || '').toLowerCase()}" onclick={() => viewDetail(t.id)}>
                        <div class="flex justify-between items-center">
                          <span class="font-semibold text-sm">{t.label || t.id}</span>
                          <div class="flex gap-1">
                            {#if t.wasEngaged}<span class="badge badge-xs badge-success">已回应 ×{t.interventionCount || 1}</span>{/if}
                            {#if t.source === 'history'}<span class="badge badge-xs badge-ghost">历史</span>{/if}
                            <span class="badge badge-xs">{t.state}</span>
                          </div>
                        </div>
                        <div class="text-xs opacity-70 mt-1">{t.summary || ''}</div>
                        <div class="text-xs mt-1">
                          <span class="opacity-50">{t.startedAt ? new Date(t.startedAt).toLocaleString() : ''}</span> |
                          参与者: {#each (t.participantIds || []) as p, i}{#if i > 0}, {/if}<button class="clickable-link" onclick={(e) => { e.stopPropagation(); quickQueryUser(p, g.chatId); }}>{p}</button>{:else}无{/each} |
                          消息数: {(t.messageIds || []).length} |
                          关键词: {(t.keywords || []).join(', ')}
                        </div>
                      </div>
                    {/each}
                    {#if cached.hasMore}
                      <div class="text-center mt-2">
                        <button class="btn btn-xs btn-outline" onclick={() => loadMore(g.chatId)}>加载更多...</button>
                      </div>
                    {/if}
                  </div>
                {/if}
              {:else}
                <div class="text-xs opacity-60">加载中...</div>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
.topic-card {
  border-left: 3px solid var(--color-primary);
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  background: var(--color-base-200);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.topic-card:hover { background: var(--color-base-300); }
.topic-card.state-active { border-color: var(--color-success); }
.topic-card.state-stale { border-color: var(--color-warning); }
.topic-card.state-archived { border-color: color-mix(in srgb, var(--color-base-content) 30%, transparent); }

@media (max-width: 768px) {
  .topics-header { flex-wrap: wrap; gap: 0.5rem; }
  .topics-header .flex.gap-2 { width: 100%; }
  .topics-header input { width: 100% !important; flex: 1; }
  .topic-card .text-xs.mt-1:last-child { display: none; }
}
</style>
