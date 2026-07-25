<script>
  import { onMount, onDestroy } from "svelte";
  import { api } from "../../lib/api.js";

  export let config;

  let status = null;
  let statusTimer = null;

  // Ensure circuitBreaker object exists
  $: if (!config.circuitBreaker) {
    config.circuitBreaker = {
      enabled: true,
      failureThreshold: 5,
      cooldownBaseMs: 60000,
      cooldownFactor: 1.5,
      cooldownMaxMs: 300000,
    };
  }

  async function fetchStatus() {
    try {
      status = await api("/circuit-breaker/status");
    } catch {}
  }

  /** 毫秒 → 人类可读简短时长 */
  function formatMs(ms) {
    if (ms == null || isNaN(ms)) return "—";
    const n = Number(ms);
    if (n <= 0) return "0s";
    const sec = Math.round(n / 1000);
    if (sec < 60) return sec + "s";
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    if (rem === 0) return min + "min";
    return min + "min" + rem + "s";
  }

  /** 计算退避序列预览 */
  $: ladder = (() => {
    const cb = config.circuitBreaker;
    if (!cb) return [];
    const base = Number(cb.cooldownBaseMs);
    const factor = Number(cb.cooldownFactor);
    const max = Number(cb.cooldownMaxMs);
    if (!(base > 0) || !(factor >= 1) || !(max > 0)) return [];
    const steps = [];
    let cur = base;
    for (let i = 0; i < 6; i++) {
      steps.push(Math.min(cur, max));
      if (cur >= max) break;
      const next = cur * factor;
      if (next <= cur) break; // factor <= 1，不再增长
      cur = next;
    }
    return steps;
  })();

  /** 熔断中的条目数 */
  $: trippedCount =
    status && status.entries
      ? status.entries.filter((e) => e.state !== "closed").length
      : 0;

  function stateMeta(state) {
    switch (state) {
      case "closed":
        return { cls: "badge-success", label: "正常" };
      case "open":
        return { cls: "badge-error", label: "熔断" };
      case "half_open":
        return { cls: "badge-warning", label: "探测" };
      default:
        return { cls: "badge-ghost", label: state || "—" };
    }
  }

  onMount(() => {
    fetchStatus();
    statusTimer = setInterval(fetchStatus, 3000);
  });
  onDestroy(() => {
    if (statusTimer) clearInterval(statusTimer);
  });
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-bolt-lightning opacity-50 mr-1"></i> LLM 熔断器
</h3>
<p class="text-xs opacity-50 mb-3">
  某个 profile 连续失败时自动熔断，避免持续请求已故障的 LLM。冷却期采用指数退避，恢复时先发探测请求。
</p>

<!-- Enable toggle -->
<label class="cfg-check mb-3">
  <input
    type="checkbox"
    class="toggle toggle-sm toggle-primary"
    bind:checked={config.circuitBreaker.enabled}
  />
  <span class="ml-2">启用熔断器</span>
</label>

{#if !config.circuitBreaker.enabled}
  <div class="text-xs opacity-40 italic">
    <i class="fa-solid fa-circle-info mr-1"></i>
    熔断器已关闭，所有 profile 将始终被尝试调用（不会跳过故障 profile）。
  </div>
{:else}
  <!-- Config fields -->
  <div class="divider text-xs opacity-50 my-2">
    <i class="fa-solid fa-sliders mr-1"></i>熔断参数
  </div>
  <div class="cfg-grid-2">
    <label class="cfg-field">
      <span class="cfg-label">连续失败阈值 (次)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.circuitBreaker.failureThreshold}
        min="1"
        step="1"
      />
      <span class="text-xs opacity-40">连续失败多少次后熔断该 profile</span>
    </label>
    <label class="cfg-field">
      <span class="cfg-label">退避系数 (×)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.circuitBreaker.cooldownFactor}
        min="1.0"
        step="0.1"
      />
      <span class="text-xs opacity-40">每次重新熔断后冷却时长乘以这个系数</span>
    </label>
    <label class="cfg-field">
      <span class="cfg-label">冷却基数 (ms)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.circuitBreaker.cooldownBaseMs}
        min="1000"
        step="1000"
      />
      <span class="text-xs opacity-40"
        >首次熔断的冷却时长 = {formatMs(
          config.circuitBreaker.cooldownBaseMs,
        )}</span
      >
    </label>
    <label class="cfg-field">
      <span class="cfg-label">冷却上限 (ms)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.circuitBreaker.cooldownMaxMs}
        min={config.circuitBreaker.cooldownBaseMs}
        step="1000"
      />
      <span class="text-xs opacity-40"
        >退避封顶值 = {formatMs(config.circuitBreaker.cooldownMaxMs)}</span
      >
    </label>
  </div>

  <!-- Cooldown ladder preview -->
  {#if ladder.length > 0}
    <div class="ladder-preview mt-2">
      <span class="text-xs opacity-50">
        <i class="fa-solid fa-arrow-trend-up mr-1"></i>退避序列：
      </span>
      {#each ladder as step, i}
        {#if i > 0}<span class="ladder-arrow">→</span>{/if}
        <span
          class="ladder-step"
          class:capped={step >= config.circuitBreaker.cooldownMaxMs}
        >
          {formatMs(step)}
          {#if step >= config.circuitBreaker.cooldownMaxMs}
            <span class="ladder-cap">封顶</span>
          {/if}
        </span>
      {/each}
    </div>
  {/if}

  <!-- Live status -->
  <div class="divider text-xs opacity-50 my-3">
    <i class="fa-solid fa-wave-square mr-1"></i>实时状态
  </div>

  {#if !status}
    <div class="text-center text-xs opacity-40 py-6">
      <span class="loading loading-xs loading-spinner mr-1"></span> 加载中…
    </div>
  {:else if status.entries && status.entries.length > 0}
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs opacity-50">
        {status.entries.length} 个 profile 被追踪，<span
          class="text-error font-semibold">{trippedCount}</span
        >
        个熔断中
      </span>
    </div>
    <table class="table table-xs w-full">
      <thead>
        <tr>
          <th>组件</th>
          <th>Profile</th>
          <th class="text-center">状态</th>
          <th class="text-center">连续错误</th>
          <th class="text-center">冷却剩余</th>
        </tr>
      </thead>
      <tbody>
        {#each status.entries as e (e.component + "/" + e.profileName)}
          {@const m = stateMeta(e.state)}
          <tr>
            <td class="font-mono text-xs">{e.component}</td>
            <td class="font-mono text-xs">{e.profileName}</td>
            <td class="text-center">
              <span class="badge badge-sm {m.cls} gap-1">
                {#if e.probing}
                  <span class="probe-dot"></span>
                {/if}
                {m.label}
              </span>
            </td>
            <td class="text-center">{e.consecutiveErrors ?? 0}</td>
            <td class="text-center font-mono">
              {#if e.cooldownRemainingMs > 0}
                {formatMs(e.cooldownRemainingMs)}
              {:else}
                <span class="opacity-30">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <div class="empty-state">
      <i class="fa-solid fa-heart-pulse empty-icon"></i>
      <div class="empty-text">暂无熔断记录</div>
      <div class="empty-sub">所有 profile 运行正常</div>
    </div>
  {/if}
{/if}

<!-- TODO: 未来可加「重置所有熔断状态」按钮，需后端提供 POST /circuit-breaker/reset 端点 -->

<style>
  .ladder-preview {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-base-200);
  }
  .ladder-step {
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 0.72rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    color: var(--color-primary);
  }
  .ladder-step.capped {
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
  }
  .ladder-cap {
    font-size: 0.55rem;
    margin-left: 0.2rem;
    opacity: 0.7;
  }
  .ladder-arrow {
    font-size: 0.6rem;
    opacity: 0.35;
  }
  .probe-dot {
    display: inline-block;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 999px;
    background: currentColor;
    animation: cb-pulse 1.2s ease-in-out infinite;
  }
  @keyframes cb-pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.35;
      transform: scale(1.45);
    }
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    text-align: center;
    opacity: 0.65;
  }
  .empty-icon {
    font-size: 1.75rem;
    color: oklch(0.7 0.15 160);
    margin-bottom: 0.5rem;
  }
  .empty-text {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .empty-sub {
    font-size: 0.7rem;
    opacity: 0.6;
    margin-top: 0.15rem;
  }
</style>
