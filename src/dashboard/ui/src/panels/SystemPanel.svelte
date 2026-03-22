<script>
  import { appState, activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { shortId, escapeHtml, renderJsonHighlighted, getPlatform, platformLabel } from '../lib/utils.js';

  let globalStateEl;
  let pool = {};
  let feedbackWindows = [];
  let callbacks = [];

  $: groups = $appState.groups;
  $: if ($activeTab === 'system') refreshSystem();

  async function refreshSystem() {
    const gs = await api('/global-state');
    if (globalStateEl) renderJsonHighlighted(globalStateEl, gs);

    pool = await api('/sandbox/pool');
    const fl = await api('/feedbackloop');
    feedbackWindows = fl.activeWindows || [];
    callbacks = await api('/callbacks') || [];
  }
</script>

<div class="grid grid-cols-2 gap-4">
  <!-- Global State -->
  <div class="card bg-base-100">
    <div class="card-body p-4">
      <h3 class="card-title text-sm">全局状态</h3>
      <pre bind:this={globalStateEl}
           class="json-display bg-base-300 p-3 rounded-lg overflow-auto max-h-[30vh] text-xs whitespace-pre-wrap"></pre>
    </div>
  </div>

  <!-- Sandbox Pool -->
  <div class="card bg-base-100">
    <div class="card-body p-4">
      <h3 class="card-title text-sm">SandboxPool 状态</h3>
      <div class="stats stats-vertical shadow w-full">
        <div class="stat py-2">
          <div class="stat-title text-xs">总实例 / 使用中 / 空闲</div>
          <div class="stat-value text-sm">{pool.total || 0} / {pool.inUse || 0} / {pool.idle || 0}</div>
        </div>
      </div>
      {#if (pool.instances || []).length}
        <div class="mt-2 space-y-1">
          {#each pool.instances as i}
            <div class="flex justify-between text-xs px-2 py-1 bg-base-200 rounded">
              <span class="font-mono">
                {#if getPlatform(i.chatId)}<span class="platform-badge platform-{getPlatform(i.chatId)}">{platformLabel(getPlatform(i.chatId))}</span>{/if}
                {shortId(i.chatId)}
              </span>
              <span class="badge badge-xs" class:badge-error={i.inUse} class:badge-success={!i.inUse}>
                {i.inUse ? '使用中' : '空闲'}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- FeedbackLoop -->
  <div class="card bg-base-100">
    <div class="card-body p-4">
      <h3 class="card-title text-sm">追问检测窗口 (FeedbackLoop)</h3>
      {#if feedbackWindows.length}
        {#each feedbackWindows as w}
          <div class="flex justify-between text-xs px-2 py-1 bg-base-200 rounded mb-1">
            <span class="font-mono">
              {#if getPlatform(w.chatId)}<span class="platform-badge platform-{getPlatform(w.chatId)}">{platformLabel(getPlatform(w.chatId))}</span>{/if}
              {shortId(w.chatId)}
            </span>
            <span>剩余 {(w.remainingMs / 1000).toFixed(0)}s</span>
          </div>
        {/each}
      {:else}
        <div class="text-xs opacity-60">无活跃窗口</div>
      {/if}
    </div>
  </div>

  <!-- Group Overview -->
  <div class="card bg-base-100">
    <div class="card-body p-4">
      <h3 class="card-title text-sm">群组概览 (Stickiness + Engagement)</h3>
      <div class="overflow-x-auto">
        <table class="table table-xs">
          <thead><tr>
            <th>ChatId</th><th>Stickiness</th><th>Engagement</th><th>Buffer</th><th>Attend #</th><th>FastPath</th>
          </tr></thead>
          <tbody>
            {#each groups as g}
              {@const fp = g.fastPathStatus || {}}
              <tr>
                <td class="font-mono text-xs">
                  {#if getPlatform(g.chatId)}<span class="platform-badge platform-{getPlatform(g.chatId)}">{platformLabel(getPlatform(g.chatId))}</span>{/if}
                  {shortId(g.chatId)}
                </td>
                <td class="stickiness-{g.stickiness}">{g.stickiness}</td>
                <td>{(g.engagement || 0).toFixed(1)}</td>
                <td>{g.bufferSize || 0}</td>
                <td>{g.attendCount || 0}</td>
                <td>
                  {#if fp.authorized}
                    <span class="badge badge-xs badge-warning">{fp.repliesSent}/{fp.maxReplies}</span>
                  {:else}
                    <span class="opacity-40">-</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Callbacks -->
  <div class="card bg-base-100 col-span-2">
    <div class="card-body p-4">
      <h3 class="card-title text-sm">最近 Callbacks (Q5)</h3>
      <div class="space-y-1 overflow-y-auto max-h-[30vh] text-xs font-mono">
        {#if !callbacks.length}
          <div class="opacity-60">无回调</div>
        {:else}
          {#each callbacks.slice(-20) as cb}
            <div class="decision-item">
              <span class="badge badge-xs" class:badge-success={cb.status === 'COMPLETED'} class:badge-error={cb.status !== 'COMPLETED'}>{cb.status}</span>
              <span class="font-mono">
                {#if getPlatform(cb.chatId)}<span class="platform-badge platform-{getPlatform(cb.chatId)}">{platformLabel(getPlatform(cb.chatId))}</span>{/if}
                {shortId(cb.chatId)}
              </span>
              <span class="badge badge-xs">{cb.executionType}</span>
              {cb.summary || ''}
              <span class="opacity-50">{cb.durationMs}ms</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
</div>
