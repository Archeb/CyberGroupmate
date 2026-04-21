<script>
  import { onMount, onDestroy } from "svelte";
  import { api } from "../../lib/api.js";

  export let config;
  export let profileNames = [];

  let stats = null;
  let statsTimer = null;
  let newProfileOverride = "";

  // Ensure rateLimiting object exists
  $: if (!config.rateLimiting) {
    config.rateLimiting = {
      enabled: false,
      maxConcurrency: 0,
      requestsPerMinute: 0,
      perProfile: {},
    };
  }
  $: if (!config.rateLimiting.perProfile) {
    config.rateLimiting.perProfile = {};
  }

  async function fetchStats() {
    try {
      stats = await api("/rate-limiter/stats");
    } catch {}
  }

  function addProfileOverride() {
    const name = newProfileOverride.trim();
    if (!name || config.rateLimiting.perProfile[name]) return;
    config.rateLimiting.perProfile[name] = { maxConcurrency: 0, requestsPerMinute: 0 };
    config.rateLimiting = config.rateLimiting; // trigger reactivity
    newProfileOverride = "";
  }

  function removeProfileOverride(name) {
    delete config.rateLimiting.perProfile[name];
    config.rateLimiting = config.rateLimiting;
  }

  onMount(() => {
    fetchStats();
    statsTimer = setInterval(fetchStats, 3000);
  });
  onDestroy(() => {
    if (statsTimer) clearInterval(statsTimer);
  });
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-gauge-high opacity-50 mr-1"></i> LLM 请求限速
</h3>
<p class="text-xs opacity-50 mb-3">
  控制 LLM API 的并发数和每分钟请求数（RPM），防止超限。超限请求会排队等待。
</p>

<!-- Enable toggle -->
<label class="cfg-check mb-3">
  <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={config.rateLimiting.enabled} />
  <span class="ml-2">启用限速</span>
</label>

{#if config.rateLimiting.enabled}
  <!-- Global limits -->
  <div class="divider text-xs opacity-50 my-2">
    <i class="fa-solid fa-globe mr-1"></i>全局限制
  </div>
  <div class="cfg-grid-2">
    <label class="cfg-field">
      <span class="cfg-label">最大并发数</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.rateLimiting.maxConcurrency}
        min="0"
        placeholder="0 = 不限制"
      />
      <span class="text-xs opacity-40">0 = 不限制</span>
    </label>
    <label class="cfg-field">
      <span class="cfg-label">RPM (每分钟请求数)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.rateLimiting.requestsPerMinute}
        min="0"
        placeholder="0 = 不限制"
      />
      <span class="text-xs opacity-40">0 = 不限制</span>
    </label>
  </div>

  <!-- Per-profile overrides -->
  <div class="divider text-xs opacity-50 my-3">
    <i class="fa-solid fa-layer-group mr-1"></i>按 Profile 覆盖
  </div>
  <p class="text-xs opacity-40 mb-2">
    为特定 Profile 设置独立的限速参数，覆盖全局设置。
  </p>

  {#each Object.entries(config.rateLimiting.perProfile) as [name, override]}
    <div class="profile-card mb-2">
      <div class="flex justify-between items-center mb-2">
        <span class="font-mono font-bold text-sm">{name}</span>
        <button
          class="btn btn-xs btn-outline btn-error"
          on:click={() => removeProfileOverride(name)}
        >
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
      <div class="cfg-grid-2">
        <label class="cfg-field">
          <span class="cfg-label">最大并发数</span>
          <input
            type="number"
            class="input input-xs input-bordered w-full"
            bind:value={override.maxConcurrency}
            min="0"
            placeholder="0 = 跟随全局"
          />
        </label>
        <label class="cfg-field">
          <span class="cfg-label">RPM</span>
          <input
            type="number"
            class="input input-xs input-bordered w-full"
            bind:value={override.requestsPerMinute}
            min="0"
            placeholder="0 = 跟随全局"
          />
        </label>
      </div>
    </div>
  {/each}

  <div class="flex items-center gap-2 mt-2">
    <select class="select select-xs select-bordered" bind:value={newProfileOverride}>
      <option value="">选择 Profile...</option>
      {#each profileNames.filter(n => !config.rateLimiting.perProfile[n]) as name}
        <option value={name}>{name}</option>
      {/each}
    </select>
    <button
      class="btn btn-xs btn-outline btn-primary"
      on:click={addProfileOverride}
      disabled={!newProfileOverride}
    >
      <i class="fa-solid fa-plus"></i> 添加覆盖
    </button>
  </div>

  <!-- Live stats -->
  {#if stats}
    <div class="divider text-xs opacity-50 my-3">
      <i class="fa-solid fa-chart-bar mr-1"></i>实时状态
    </div>
    <div class="grid grid-cols-3 gap-2 text-center">
      <div class="stat-card">
        <div class="text-2xl font-bold">{stats.activeConcurrency}</div>
        <div class="text-xs opacity-50">活跃并发</div>
      </div>
      <div class="stat-card">
        <div class="text-2xl font-bold">{stats.queueLength}</div>
        <div class="text-xs opacity-50">排队中</div>
      </div>
      <div class="stat-card">
        <div class="text-2xl font-bold">{stats.recentRPM}</div>
        <div class="text-xs opacity-50">近 1min 请求</div>
      </div>
    </div>
    {#if Object.keys(stats.perProfile).length > 0}
      <div class="mt-2">
        <table class="table table-xs w-full">
          <thead>
            <tr>
              <th>Profile</th>
              <th class="text-center">并发</th>
              <th class="text-center">排队</th>
              <th class="text-center">RPM</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(stats.perProfile) as [name, ps]}
              <tr>
                <td class="font-mono text-xs">{name}</td>
                <td class="text-center">{ps.activeConcurrency}</td>
                <td class="text-center">{ps.queueLength}</td>
                <td class="text-center">{ps.recentRPM}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
{/if}

<style>
  .stat-card {
    background: oklch(0.25 0 0);
    border-radius: 0.5rem;
    padding: 0.5rem;
  }
</style>
