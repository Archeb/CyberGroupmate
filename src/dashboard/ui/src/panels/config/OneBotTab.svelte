<script>
  import { api } from '../../lib/api.js';
  import MonacoEditor from '../../components/MonacoEditor.svelte';

  export let config;
  export let onebotEnabled = false;

  let catalogStats = null;
  let statsLoading = false;

  async function loadCatalogStats() {
    statsLoading = true;
    try {
      catalogStats = await api('/image-catalog/stats');
    } catch { catalogStats = null; }
    statsLoading = false;
  }
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-comments opacity-50 mr-1"></i> QQ / OneBot 设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={onebotEnabled}
  />
  <span class="text-sm font-medium">启用 OneBot Adapter</span>
</label>
{#if !onebotEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!onebotEnabled} class:pointer-events-none={!onebotEnabled}>
  <p class="text-xs opacity-50 mb-3">通过 OneBot v11 协议连接 NapCat / go-cqhttp 等 QQ 框架。</p>
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> WebSocket 地址</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full font-mono"
        bind:value={config.onebot.wsUrl}
        placeholder="ws://127.0.0.1:3001"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot QQ 号</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full font-mono"
        bind:value={config.onebot.selfId}
        placeholder="123456789"
      /></label
    >
  </div>
  <label class="cfg-check mt-3 mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.onebot.sendFileAsDataUrl}
    />
    <span><i class="fa-solid fa-rotate-right restart-icon"></i> 发送本地文件时改用 Data URL payload</span>
  </label>
  <p class="text-xs opacity-60 mb-1">跨机器部署 NapCat 时建议开启，避免 `file://` 路径在 QQ 端不可达。</p>
  <p class="text-xs opacity-60 mb-3">开启后会发送 `data:image/png;base64,...` 这类文件内容。</p>
  <div class="divider text-xs opacity-50 my-3">拟人化发送延迟</div>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.onebot.humanizedDelay.enabled}
    />
    <span>启用拟人化延迟</span>
  </label>
  {#if config.onebot.humanizedDelay.enabled}
    <div class="cfg-grid-3">
      <label class="cfg-field"
        ><span class="cfg-label">每字符 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.onebot.humanizedDelay.msPerChar}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最小 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.onebot.humanizedDelay.minDelay}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最大 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.onebot.humanizedDelay.maxDelay}
        /></label
      >
    </div>
  {/if}
  <div class="divider text-xs opacity-50 my-3">
    入站白名单 <span class="restart-hint"
      ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
    >
  </div>
  <p class="text-xs opacity-50 mb-2">启用后仅处理列表中的群聊或私聊；私聊按对方 QQ 号匹配。</p>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.onebot.whitelist.enabled}
    />
    <span>启用白名单</span>
  </label>
  <div class="cfg-grid-2">
    <div class="cfg-field col-span-2"
      ><span class="cfg-label">群号（每行一个）</span>
      <MonacoEditor
        language="plaintext"
        height={120}
        value={config.onebot.whitelist.groups.join("\n")}
        on:change={(e) => {
          config.onebot.whitelist.groups = e.detail.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      /></div
    >
    <div class="cfg-field col-span-2"
      ><span class="cfg-label">私聊 QQ 号（每行一个）</span>
      <MonacoEditor
        language="plaintext"
        height={120}
        value={config.onebot.whitelist.users.join("\n")}
        on:change={(e) => {
          config.onebot.whitelist.users = e.detail.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      /></div
    >
  </div>
  <div class="divider text-xs opacity-50 my-3">
    偷表情包 <span class="restart-hint"><i class="fa-solid fa-rotate-right"></i> 修改需重启</span>
  </div>
  <p class="text-xs opacity-50 mb-2">自动追踪群聊中反复出现的图片，用 Vision LLM 判定并收录为表情包。</p>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.vision.stickerStealingEnabled}
    />
    <span>启用偷表情包</span>
  </label>
  {#if config.vision.stickerStealingEnabled}
    <div class="cfg-grid-3 mb-3">
      <label class="cfg-field"
        ><span class="cfg-label">最小出现次数</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.vision.stickerStealingMinFrequency}
          placeholder="3"
          min="1"
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">检测间隔 (分钟)</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.vision.stickerStealingIntervalMin}
          placeholder="10"
          min="1"
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">目录保留天数</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.vision.catalogRetentionDays}
          placeholder="30"
          min="1"
        /></label
      >
    </div>

    <!-- 状态面板 -->
    <div class="p-3 bg-base-200 rounded-lg">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-bold opacity-70">
          <i class="fa-solid fa-chart-bar opacity-50 mr-1"></i>图片目录状态
        </span>
        <button class="btn btn-xs btn-ghost" on:click={loadCatalogStats} title="刷新状态">
          {#if statsLoading}
            <span class="loading loading-spinner loading-xs"></span>
          {:else}
            <i class="fa-solid fa-rotate"></i>
          {/if}
        </button>
      </div>
      {#if catalogStats}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
          <div class="stat-card">
            <span class="stat-num">{catalogStats.totalImages}</span>
            <span class="stat-label">总追踪</span>
          </div>
          <div class="stat-card">
            <span class="stat-num text-warning">{catalogStats.pendingCandidates}</span>
            <span class="stat-label">待判定</span>
          </div>
          <div class="stat-card">
            <span class="stat-num text-success">{catalogStats.confirmedStickers}</span>
            <span class="stat-label">已收录</span>
          </div>
          <div class="stat-card">
            <span class="stat-num text-error">{catalogStats.rejectedImages}</span>
            <span class="stat-label">已排除</span>
          </div>
        </div>
        {#if catalogStats.recentPromotions.length > 0}
          <div class="text-xs opacity-60 mb-1">最近收录</div>
          <div class="space-y-1">
            {#each catalogStats.recentPromotions as p}
              <div class="flex items-center gap-2 text-xs">
                <span class="text-base">{p.emoji || '🎭'}</span>
                <span class="truncate flex-1" title={p.description}>{p.description || '-'}</span>
                <span class="opacity-40 whitespace-nowrap">{p.promotedAt ? new Date(p.promotedAt).toLocaleDateString() : ''}</span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-xs opacity-40 italic">暂无已收录的表情包。</p>
        {/if}
      {:else}
        <p class="text-xs opacity-40 italic">点击刷新按钮加载状态。</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .stat-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.4rem;
    border-radius: 0.375rem;
    background: var(--color-base-100);
  }
  .stat-num {
    font-size: 1.1rem;
    font-weight: 700;
    line-height: 1.2;
  }
  .stat-label {
    font-size: 0.65rem;
    opacity: 0.5;
  }
</style>
