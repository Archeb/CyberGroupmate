<script>
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';

  let stats = {
    rows: [],
    totals: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, callCount: 0, totalCost: 0 },
    updatedAt: '',
  };
  let meta = { models: [], callers: [] };
  let loading = false;

  // ─── 筛选/排序状态 ───
  let groupBy = 'model';
  let period = 'all';
  let customFrom = '';
  let customTo = '';
  let filterModel = '';
  let filterCaller = '';
  let sortBy = 'cost';
  let sortDir = 'desc';

  $: if ($activeTab === 'token-stats') { loadMeta(); refresh(); }
  $: if ($activeTab === 'token-stats') {
    groupBy;
    period;
    filterModel;
    filterCaller;
    sortBy;
    sortDir;
    refresh();
  }

  async function loadMeta() {
    try {
      meta = await api('/token-stats/meta');
    } catch { /* ignore */ }
  }

  async function refresh() {
    loading = true;
    try {
      const q = new URLSearchParams({ groupBy, sortBy, sortDir });
      if (period === 'custom') {
        if (customFrom) q.set('from', new Date(customFrom).toISOString());
        if (customTo)   q.set('to',   new Date(customTo + 'T23:59:59').toISOString());
      } else {
        q.set('period', period);
      }
      if (filterModel)  q.set('filterModel', filterModel);
      if (filterCaller) q.set('filterCaller', filterCaller);
      stats = await api(`/token-stats?${q}`);
    } catch { /* ignore */ }
    loading = false;
  }

  function applyCustomRange() {
    period = 'custom';
    refresh();
  }

  async function resetStats() {
    if (!confirm('确定清零所有 Token 统计？此操作不可逆。')) return;
    await api('/token-stats/reset', { method: 'POST' });
    await loadMeta();
    await refresh();
  }

  function toggleSort(col) {
    if (sortBy === col) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortBy = col;
      sortDir = 'desc';
    }
  }

  function sortIcon(col) {
    if (sortBy !== col) return '⇅';
    return sortDir === 'desc' ? '↓' : '↑';
  }

  function formatCost(cost) {
    if (!cost || cost === 0) return '-';
    if (cost < 0.0001) return `$${cost.toFixed(8)}`;
    if (cost < 0.01)   return `$${cost.toFixed(6)}`;
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

  const PERIOD_LABELS = { hour: '1小时', day: '今日', week: '本周', month: '本月', all: '全部', custom: '自定义' };
  const PERIOD_KEYS   = ['hour', 'day', 'week', 'month', 'all', 'custom'];
  const GROUPBY_LABELS = { model: '按模型', caller: '按模块', both: '模型×模块' };
  const GROUPBY_KEYS   = ['model', 'caller', 'both'];
</script>

<div class="token-stats-panel">
  <div class="token-stats-header">
    <h3>Token 用量与费用统计</h3>
    <div class="token-stats-actions">
      {#if stats.updatedAt}
        <span class="text-xs opacity-40">更新于 {timeAgo(stats.updatedAt)}</span>
      {/if}
      <button class="btn btn-xs btn-ghost" onclick={refresh} disabled={loading}>刷新</button>
      <button class="btn btn-xs btn-error btn-outline" onclick={resetStats}>清零</button>
    </div>
  </div>

  <div class="controls-section">
    <div class="ctrl-row">
      <span class="ctrl-label">时段</span>
      <div class="ctrl-group">
        {#each PERIOD_KEYS as p}
          <button class="ctrl-btn" class:active={period === p} onclick={() => { period = p; }}>{PERIOD_LABELS[p]}</button>
        {/each}
      </div>
      {#if period === 'custom'}
        <div class="date-range">
          <input type="date" class="date-input" bind:value={customFrom} onchange={applyCustomRange} />
          <span class="opacity-40">—</span>
          <input type="date" class="date-input" bind:value={customTo} onchange={applyCustomRange} />
        </div>
      {/if}
    </div>

    <div class="ctrl-row">
      <span class="ctrl-label">分组</span>
      <div class="ctrl-group">
        {#each GROUPBY_KEYS as g}
          <button class="ctrl-btn" class:active={groupBy === g} onclick={() => groupBy = g}>{GROUPBY_LABELS[g]}</button>
        {/each}
      </div>
    </div>

    {#if meta.models.length > 0}
      <div class="ctrl-row">
        <span class="ctrl-label">模型</span>
        <select class="ctrl-select" bind:value={filterModel}>
          <option value="">全部</option>
          {#each meta.models as m}<option value={m}>{m}</option>{/each}
        </select>
      </div>
    {/if}

    {#if meta.callers.length > 0}
      <div class="ctrl-row">
        <span class="ctrl-label">模块</span>
        <select class="ctrl-select" bind:value={filterCaller}>
          <option value="">全部</option>
          {#each meta.callers as c}<option value={c}>{c}</option>{/each}
        </select>
      </div>
    {/if}
  </div>

  <div class="token-stats-summary">
    <div class="stat-card"><div class="stat-label">总调用</div><div class="stat-value">{formatTokens(stats.totals.callCount)}</div></div>
    <div class="stat-card"><div class="stat-label">总输入 Token</div><div class="stat-value">{formatTokens(stats.totals.promptTokens)}</div></div>
    <div class="stat-card"><div class="stat-label">总输出 Token</div><div class="stat-value">{formatTokens(stats.totals.completionTokens)}</div></div>
    <div class="stat-card"><div class="stat-label">缓存命中</div><div class="stat-value">{formatTokens(stats.totals.cachedTokens)}</div></div>
    <div class="stat-card stat-card-cost"><div class="stat-label">总费用</div><div class="stat-value">{formatCost(stats.totals.totalCost)}</div></div>
  </div>

  {#if !stats.rows || stats.rows.length === 0}
    <div class="text-sm opacity-40 p-4">{loading ? '加载中…' : '暂无统计数据'}</div>
  {:else}
    <div class="token-stats-table-wrap">
      <table class="token-stats-table">
        <thead>
          <tr>
            {#if groupBy === 'model' || groupBy === 'both'}<th>模型</th>{/if}
            {#if groupBy === 'caller' || groupBy === 'both'}<th>模块</th>{/if}
            <th class="num sortable" onclick={() => toggleSort('callCount')}>调用 {sortIcon('callCount')}</th>
            <th class="num sortable" onclick={() => toggleSort('promptTokens')}>输入 {sortIcon('promptTokens')}</th>
            <th class="num sortable" onclick={() => toggleSort('completionTokens')}>输出 {sortIcon('completionTokens')}</th>
            <th class="num hide-mobile">缓存命中</th>
            <th class="num hide-mobile">缓存创建</th>
            <th class="num sortable" onclick={() => toggleSort('cost')}>费用 {sortIcon('cost')}</th>
            <th>最近使用</th>
          </tr>
        </thead>
        <tbody>
          {#each stats.rows as row}
            <tr>
              {#if groupBy === 'model' || groupBy === 'both'}<td class="key-name">{row.model ?? row.key}</td>{/if}
              {#if groupBy === 'caller' || groupBy === 'both'}<td class="key-name">{row.caller ?? row.key}</td>{/if}
              <td class="num">{formatTokens(row.callCount)}</td>
              <td class="num">{formatTokens(row.promptTokens)}</td>
              <td class="num">{formatTokens(row.completionTokens)}</td>
              <td class="num hide-mobile">{row.cachedTokens ? formatTokens(row.cachedTokens) : '-'}</td>
              <td class="num hide-mobile">{row.cacheCreationTokens ? formatTokens(row.cacheCreationTokens) : '-'}</td>
              <td class="num cost">{formatCost(row.totalCost)}</td>
              <td class="time">{timeAgo(row.lastSeenAt)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <td colspan={groupBy === 'both' ? 2 : 1}><b>合计</b></td>
            <td class="num"><b>{formatTokens(stats.totals.callCount)}</b></td>
            <td class="num"><b>{formatTokens(stats.totals.promptTokens)}</b></td>
            <td class="num"><b>{formatTokens(stats.totals.completionTokens)}</b></td>
            <td class="num hide-mobile"><b>{stats.totals.cachedTokens ? formatTokens(stats.totals.cachedTokens) : '-'}</b></td>
            <td class="num hide-mobile"><b>{stats.totals.cacheCreationTokens ? formatTokens(stats.totals.cacheCreationTokens) : '-'}</b></td>
            <td class="num cost"><b>{formatCost(stats.totals.totalCost)}</b></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  {/if}
</div>

<style>
  .token-stats-panel { background: var(--color-base-100); border-radius: var(--radius-box, 0.5rem); padding: 1rem; min-height: calc(100vh - 220px); }
  .token-stats-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .token-stats-header h3 { font-size: 1rem; font-weight: 700; margin: 0; }
  .token-stats-actions { display: flex; align-items: center; gap: 0.5rem; }
  .controls-section { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 1rem; }
  .ctrl-row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
  .ctrl-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.45; width: 2.5rem; flex-shrink: 0; }
  .ctrl-group { display: flex; border: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent); border-radius: 0.375rem; overflow: hidden; }
  .ctrl-btn { padding: 0.2rem 0.65rem; font-size: 0.72rem; background: transparent; border: none; border-right: 1px solid color-mix(in srgb, var(--color-base-content) 10%, transparent); cursor: pointer; color: inherit; opacity: 0.6; transition: background 0.1s, opacity 0.1s; }
  .ctrl-btn:last-child { border-right: none; }
  .ctrl-btn:hover { background: color-mix(in srgb, var(--color-base-content) 6%, transparent); opacity: 0.85; }
  .ctrl-btn.active { background: color-mix(in srgb, var(--color-primary) 15%, transparent); color: var(--color-primary); opacity: 1; font-weight: 600; }
  .ctrl-select { font-size: 0.72rem; padding: 0.2rem 0.5rem; border: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent); border-radius: 0.375rem; background: transparent; color: inherit; cursor: pointer; max-width: 260px; }
  .date-range { display: flex; align-items: center; gap: 0.4rem; }
  .date-input { font-size: 0.72rem; padding: 0.18rem 0.4rem; border: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent); border-radius: 0.375rem; background: transparent; color: inherit; cursor: pointer; }
  .token-stats-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem; }
  .stat-card { background: color-mix(in srgb, var(--color-base-content) 5%, transparent); border-radius: 0.5rem; padding: 0.75rem 1rem; }
  .stat-card-cost { border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent); background: color-mix(in srgb, var(--color-warning) 5%, transparent); }
  .stat-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.5; margin-bottom: 0.25rem; }
  .stat-value { font-size: 1.2rem; font-weight: 700; font-family: ui-monospace, monospace; }
  .stat-card-cost .stat-value { color: var(--color-warning); }
  .token-stats-table-wrap { overflow-x: auto; }
  .token-stats-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; font-family: ui-monospace, monospace; }
  .token-stats-table th, .token-stats-table td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid color-mix(in srgb, var(--color-base-content) 8%, transparent); }
  .token-stats-table th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.5; font-weight: 600; }
  .token-stats-table th.sortable { cursor: pointer; user-select: none; }
  .token-stats-table th.sortable:hover { opacity: 0.85; }
  .token-stats-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .token-stats-table .cost { color: var(--color-warning); }
  .token-stats-table .key-name { font-weight: 600; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .token-stats-table .time { font-size: 0.7rem; opacity: 0.5; }
  .token-stats-table tfoot td { border-top: 2px solid color-mix(in srgb, var(--color-base-content) 15%, transparent); border-bottom: none; }
  .token-stats-table tbody tr:hover { background: color-mix(in srgb, var(--color-base-content) 4%, transparent); }
  @media (max-width: 768px) {
    .token-stats-header { flex-wrap: wrap; gap: 0.5rem; }
    .token-stats-header h3 { font-size: 0.85rem; }
    .ctrl-label { display: none; }
    .stat-card { padding: 0.5rem 0.6rem; }
    .token-stats-summary { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 0.5rem; }
    .stat-value { font-size: 0.95rem; }
    .token-stats-table .key-name { max-width: 120px; }
    .hide-mobile { display: none; }
  }
</style>
