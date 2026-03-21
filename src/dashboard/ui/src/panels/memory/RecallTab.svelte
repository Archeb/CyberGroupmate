<script>
  import { onMount } from 'svelte';
  import { activeTab, topicDetailId } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { escapeHtml, shortId, getGroupLabel, renderJsonHighlighted } from '../../lib/utils.js';

  let queryEl;
  let recallEl;

  let userInput = '';
  let userChat = '';
  let groupInput = '';
  let recallQuery = '';
  let recallChatId = '';
  let recallResults = null;

  // Listen for quick query events
  onMount(() => {
    function onQuickUser(e) {
      userInput = e.detail.userId;
      userChat = e.detail.chatId || '';
      queryUser();
    }
    function onQuickGroup(e) {
      groupInput = e.detail.chatId;
      queryGroup();
    }
    window.addEventListener('quickQueryUser', onQuickUser);
    window.addEventListener('quickQueryGroup', onQuickGroup);
    return () => {
      window.removeEventListener('quickQueryUser', onQuickUser);
      window.removeEventListener('quickQueryGroup', onQuickGroup);
    };
  });

  async function queryUser() {
    if (!userInput) return;
    let path = `/memory/user/${userInput}`;
    if (userChat) path += `?chatId=${userChat}`;
    const result = await api(path);
    if (queryEl) renderJsonHighlighted(queryEl, result);
  }

  async function queryGroup() {
    if (!groupInput) return;
    const result = await api(`/memory/group/${groupInput}`);
    if (queryEl) renderJsonHighlighted(queryEl, result);
  }

  async function recallMemory() {
    if (!recallQuery.trim()) return;
    recallResults = null;
    try {
      const body = { query: recallQuery };
      if (recallChatId) body.chatId = recallChatId;
      recallResults = await api('/memory/recall', { method: 'POST', body });
    } catch (err) {
      recallResults = { error: String(err) };
    }
  }

  function viewTopicDetail(topicId) {
    topicDetailId.set(topicId);
    activeTab.set('topic-detail');
  }

  function quickQueryUser(userId, chatId) {
    userInput = userId;
    userChat = chatId || '';
    queryUser();
  }
</script>

<div class="flex gap-4">
  <div class="w-80 shrink-0 space-y-4">
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">用户查询</h3>
        <input type="text" placeholder="输入 userId" class="input input-sm input-bordered w-full mb-2" bind:value={userInput} />
        <input type="text" placeholder="chatId (可选)" class="input input-sm input-bordered w-full mb-2" bind:value={userChat} />
        <button class="btn btn-sm btn-primary w-full" onclick={queryUser}>查询用户画像</button>
        <div class="divider text-xs">群组查询</div>
        <input type="text" placeholder="输入 chatId" class="input input-sm input-bordered w-full mb-2" bind:value={groupInput} />
        <button class="btn btn-sm btn-secondary w-full" onclick={queryGroup}>查询群组画像</button>
      </div>
    </div>
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">🔍 记忆搜索 (Recall)</h3>
        <input type="text" placeholder="关键词 / 语义检索" class="input input-sm input-bordered w-full mb-2" bind:value={recallQuery} />
        <input type="text" placeholder="chatId (可选，限定群组)" class="input input-sm input-bordered w-full mb-2" bind:value={recallChatId} />
        <button class="btn btn-sm btn-accent w-full" onclick={recallMemory}>搜索记忆</button>
      </div>
    </div>
  </div>

  <div class="flex-1 min-w-0 space-y-4">
    <div class="card bg-base-100">
      <div class="card-body p-4 overflow-hidden">
        <h3 class="card-title text-sm mb-2">查询结果</h3>
        <pre bind:this={queryEl} class="json-display bg-base-300 p-3 rounded-lg overflow-auto max-h-[40vh] text-xs whitespace-pre-wrap">点击左侧按钮查询</pre>
      </div>
    </div>
    <div class="card bg-base-100">
      <div class="card-body p-4 overflow-hidden">
        <h3 class="card-title text-sm mb-2">🔍 搜索结果</h3>
        <div class="overflow-auto max-h-[40vh] text-xs">
          {#if !recallResults}
            <span class="opacity-60">输入关键词后点击搜索</span>
          {:else if recallResults.error}
            <div class="text-error">{recallResults.error}</div>
          {:else}
            {#if recallResults.deepSummary}
              <div class="mb-3 p-2 bg-base-200 rounded text-xs"><strong>摘要：</strong>{recallResults.deepSummary}</div>
            {/if}
            {#if recallResults.topics?.length}
              <h4 class="text-sm font-bold mb-1">🗂 话题 ({recallResults.topics.length})</h4>
              {#each recallResults.topics as t}
                <div class="topic-card mb-1 cursor-pointer" onclick={() => viewTopicDetail(t.id)}>
                  <div class="font-semibold text-xs">{t.label}</div>
                  <div class="text-xs opacity-70">{t.summary || ''}</div>
                  <div class="text-xs">{#each (t.keywords || []) as k}<span class="badge badge-xs mr-1">{k}</span>{/each}</div>
                </div>
              {/each}
            {/if}
            {#if recallResults.facts?.length}
              <h4 class="text-sm font-bold mt-2 mb-1">💡 事实 ({recallResults.facts.length})</h4>
              <div class="space-y-1">
                {#each recallResults.facts as f}
                  <div class="text-xs p-1 bg-base-200 rounded">
                    <span class="badge badge-xs">{f.category}</span>
                    <span class="font-mono">{f.subject}</span>: {f.content}
                    <span class="opacity-50">({(f.confidence * 100).toFixed(0)}%)</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if recallResults.persons?.length}
              <h4 class="text-sm font-bold mt-2 mb-1">👤 关联人物 ({recallResults.persons.length})</h4>
              {#each recallResults.persons as p}
                <div class="text-xs p-1 bg-base-200 rounded">
                  <button class="clickable-link" onclick={() => quickQueryUser(p.userId, p.chatId)}>{p.userId}</button>
                  T{p.dunbarTier} | {(p.traits || []).join(', ')}
                </div>
              {/each}
            {/if}
            {#if !recallResults.topics?.length && !recallResults.facts?.length && !recallResults.persons?.length}
              <div class="opacity-60">未找到匹配结果</div>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>
