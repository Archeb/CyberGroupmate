<script>
  import { appState } from '../lib/stores.js';
  import { api } from '../lib/api.js';

  /** platform → 是否正在手动重连 */
  let reconnecting = {};
  /** platform → 上一次手动重连的错误 */
  let reconnectError = {};

  const PLATFORM_LABELS = {
    telegram: 'Telegram',
    discord: 'Discord',
    feishu: '飞书 / Lark',
    onebot: 'QQ',
  };

  const STATE_META = {
    connected: { label: '已连接', dot: 'bg-success', text: 'text-success' },
    connecting: { label: '连接中', dot: 'bg-warning animate-pulse', text: 'text-warning' },
    disconnected: { label: '已断开', dot: 'bg-error animate-pulse', text: 'text-error' },
    error: { label: '错误', dot: 'bg-error', text: 'text-error' },
    stopped: { label: '已停止', dot: 'bg-base-300', text: 'opacity-60' },
  };

  function label(platform) {
    return PLATFORM_LABELS[platform] || platform;
  }

  function meta(state) {
    return STATE_META[state] || { label: state || '未知', dot: 'bg-base-300', text: 'opacity-60' };
  }

  /** 构造 tooltip：状态细节 + 重连计划 + 最近错误 */
  function tooltip(adapter) {
    const parts = [`${label(adapter.platform)}: ${meta(adapter.state).label}`];
    if (adapter.detail) parts.push(adapter.detail);
    if (adapter.reconnectAttempts > 0) parts.push(`重连尝试 ${adapter.reconnectAttempts} 次`);
    if (adapter.nextRetryAt) {
      const seconds = Math.max(0, Math.round((new Date(adapter.nextRetryAt) - Date.now()) / 1000));
      parts.push(`下次重连 ~${seconds}s`);
    }
    if (adapter.lastConnectedAt) {
      parts.push(`上次连上 ${new Date(adapter.lastConnectedAt).toLocaleString()}`);
    }
    if (adapter.lastError) parts.push(`错误: ${adapter.lastError}`);
    const err = reconnectError[adapter.platform];
    if (err) parts.push(`手动重连失败: ${err}`);
    return parts.join('\n');
  }

  async function reconnect(platform) {
    reconnecting = { ...reconnecting, [platform]: true };
    reconnectError = { ...reconnectError, [platform]: '' };
    try {
      const res = await api(`/adapters/${platform}/reconnect`, { method: 'POST' });
      if (res?.error) {
        reconnectError = { ...reconnectError, [platform]: String(res.error) };
      }
      if (res?.status) {
        appState.update(s => {
          s.adapters = (s.adapters || []).map(a => (a.platform === platform ? { ...a, ...res.status } : a));
          return s;
        });
      }
    } catch (err) {
      reconnectError = { ...reconnectError, [platform]: String(err) };
    } finally {
      reconnecting = { ...reconnecting, [platform]: false };
    }
  }
</script>

<div class="stats shadow w-full mb-4 bg-base-100">
  <div class="stat">
    <div class="stat-title">活跃群组</div>
    <div class="stat-value text-primary">{$appState.groups.length}</div>
  </div>
  <div class="stat">
    <div class="stat-title">Accumulator</div>
    <div class="stat-value text-secondary">{($appState.queue?.active || []).length}</div>
  </div>
  <div class="stat">
    <div class="stat-title">Sandbox 池</div>
    <div class="stat-value text-accent">{$appState.sandboxPool?.inUse || 0}/{$appState.sandboxPool?.total || 0}</div>
  </div>
  <div class="stat">
    <div class="stat-title">待处理回调</div>
    <div class="stat-value text-warning">{($appState.pendingCallbacks || []).length}</div>
  </div>
  <div class="stat">
    <div class="stat-title">平台连接</div>
    {#if ($appState.adapters || []).length === 0}
      <div class="stat-value text-base opacity-60">无 adapter</div>
    {:else}
      <div class="flex flex-col gap-1 mt-1">
        {#each $appState.adapters as adapter (adapter.platform)}
          <div class="flex items-center gap-2 text-sm" title={tooltip(adapter)}>
            <span class="inline-block w-2 h-2 rounded-full {meta(adapter.state).dot}"></span>
            <span class="font-medium">{label(adapter.platform)}</span>
            <span class="text-xs {meta(adapter.state).text}">
              {meta(adapter.state).label}{adapter.reconnectAttempts > 0 ? ` (${adapter.reconnectAttempts})` : ''}
            </span>
            {#if adapter.supportsReconnect}
              <button
                class="btn btn-ghost btn-xs"
                disabled={reconnecting[adapter.platform]}
                on:click={() => reconnect(adapter.platform)}
                title="手动重连 {label(adapter.platform)}"
              >
                {reconnecting[adapter.platform] ? '重连中…' : '重连'}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
