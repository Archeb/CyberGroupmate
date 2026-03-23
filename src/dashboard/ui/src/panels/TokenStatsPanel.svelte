<script>
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';

  let stats = { byModel: {}, updatedAt: '' };
  let loading = false;

  $: if ($activeTab === 'token-stats') refresh();

  async function refresh() {
    loading = true;
    try {
      stats = await api('/token-stats');
    } catch { /* ignore */ }
    loading = false;
  }

  async function resetStats() {
    if (!confirm('确定清零所有 Token 统计？此操作不可逆。')) return;
    await api('/token-stats/reset', { method: 'POST' });
    await refresh();
  }

  function formatCost(cost) {
    if (!cost || cost === 0) return '-';
    if (cost < 0.01) return `$${cost.toFixed(6)}`;
    return `$${cost.toFixed(4)}`;
  }

  function formatTokens(n) {
    if (!n) return '0';
    return n.toLocaleString();
  }

  function timeAgo(iso) {
    if (!iso) return '-';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  }

  $: models = Object.entries(stats.byModel || {}).sort((a, b) => b[1].totalCost - a[1].totalCost || b[1].callCount - a[1].callCount);
  $: totals = models.reduce((acc, [, s]) => ({
    promptTokens: acc.promptTokens + s.promptTokens,
    completionTokens: acc.completionTokens + s.completionTokens,
    cachedTokens: acc.cachedTokens + s.cachedTokens,
    cacheCreationTokens: acc.cacheCreationTokens + s.cacheCreationTokens,
    totalCost: acc.totalCost + s.totalCost,
    callCount: acc.callCount + s.callCount,
  }), { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, totalCost: 0, callCount: 0 });
</script>

<div class="token-stats-panel">
  <div class="token-stats-header">
    <h3>Token 用量与费用统计</h3>
    <div class="token-stats-actions">
      {#if stats.updatedAt}
        <span class="text-xs opacity-40">更新于 {timeAgo(stats.updatedAt)}</span>
      {/if}
      <button class="btn btn-xs btn-ghost" onclick={refresh}>刷新</button>
      <button class="btn btn-xs btn-error btn-outline" onclick={resetStats}>清零</button>
    </div>
  </div>

  <!-- Summary cards -->
  <div class="token-stats-summary">
    <div class="stat-card">
      <div class="stat-label">总调用</div>
      <div class="stat-value">{formatTokens(totals.callCount)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">总输入 Token</div>
      <div class="stat-value">{formatTokens(totals.promptTokens)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">总输出 Token</div>
      <div class="stat-value">{formatTokens(totals.completionTokens)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">缓存命中</div>
      <div class="stat-value">{formatTokens(totals.cachedTokens)}</div>
    </div>
    <div class="stat-card stat-card-cost">
      <div class="stat-label">总费用</div>
      <div class="stat-value">{formatCost(totals.totalCost)}</div>
    </div>
  </div>

  <!-- Per-model table -->
  {#if models.length === 0}
    <div class="text-sm opacity-40 p-4">暂无统计数据</div>
  {:else}
    <div class="token-stats-table-wrap">
      <table class="token-stats-table">
        <thead>
          <tr>
            <th>模型</th>
            <th class="num">调用</th>
            <th class="num">输入</th>
            <th class="num">输出</th>
            <th class="num hide-mobile">缓存命中</th>
            <th class="num hide-mobile">缓存创建</th>
            <th class="num">费用</th>
            <th>最近使用</th>
          </tr>
        </thead>
        <tbody>
          {#each models as [model, s]}
            <tr>
              <td class="model-name">{model}</td>
              <td class="num">{formatTokens(s.callCount)}</td>
              <td class="num">{formatTokens(s.promptTokens)}</td>
              <td class="num">{formatTokens(s.completionTokens)}</td>
              <td class="num hide-mobile">{s.cachedTokens ? formatTokens(s.cachedTokens) : '-'}</td>
              <td class="num hide-mobile">{s.cacheCreationTokens ? formatTokens(s.cacheCreationTokens) : '-'}</td>
              <td class="num cost">{formatCost(s.totalCost)}</td>
              <td class="time">{timeAgo(s.lastSeenAt)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <td><b>合计</b></td>
            <td class="num"><b>{formatTokens(totals.callCount)}</b></td>
            <td class="num"><b>{formatTokens(totals.promptTokens)}</b></td>
            <td class="num"><b>{formatTokens(totals.completionTokens)}</b></td>
            <td class="num hide-mobile"><b>{totals.cachedTokens ? formatTokens(totals.cachedTokens) : '-'}</b></td>
            <td class="num hide-mobile"><b>{totals.cacheCreationTokens ? formatTokens(totals.cacheCreationTokens) : '-'}</b></td>
            <td class="num cost"><b>{formatCost(totals.totalCost)}</b></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  {/if}
</div>

<style>
  .token-stats-panel {
    background: var(--color-base-100);
    border-radius: var(--radius-box, 0.5rem);
    padding: 1rem;
    min-height: calc(100vh - 220px);
  }

  .token-stats-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .token-stats-header h3 {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
  }

  .token-stats-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .token-stats-summary {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }

  .stat-card {
    flex: 1;
    min-width: 120px;
    background: color-mix(in srgb, var(--color-base-content) 5%, transparent);
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
  }

  .stat-card-cost {
    border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
    background: color-mix(in srgb, var(--color-warning) 5%, transparent);
  }

  .stat-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
    margin-bottom: 0.25rem;
  }

  .stat-value {
    font-size: 1.2rem;
    font-weight: 700;
    font-family: ui-monospace, monospace;
  }

  .stat-card-cost .stat-value {
    color: var(--color-warning);
  }

  .token-stats-table-wrap {
    overflow-x: auto;
  }

  .token-stats-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    font-family: ui-monospace, monospace;
  }

  .token-stats-table th,
  .token-stats-table td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid color-mix(in srgb, var(--color-base-content) 8%, transparent);
  }

  .token-stats-table th {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
    font-weight: 600;
  }

  .token-stats-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .token-stats-table .cost {
    color: var(--color-warning);
  }

  .token-stats-table .model-name {
    font-weight: 600;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .token-stats-table .time {
    font-size: 0.7rem;
    opacity: 0.5;
  }

  .token-stats-table tfoot td {
    border-top: 2px solid color-mix(in srgb, var(--color-base-content) 15%, transparent);
    border-bottom: none;
  }

  .token-stats-table tbody tr:hover {
    background: color-mix(in srgb, var(--color-base-content) 4%, transparent);
  }

  @media (max-width: 768px) {
    .token-stats-header { flex-wrap: wrap; gap: 0.5rem; }
    .token-stats-header h3 { font-size: 0.85rem; }
    .stat-card { min-width: 0; padding: 0.5rem 0.6rem; }
    .stat-value { font-size: 0.95rem; }
    .token-stats-table .model-name { max-width: 120px; }
  }
</style>
