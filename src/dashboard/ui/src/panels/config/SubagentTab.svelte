<script>
  export let config;
  export let newBaseSkill = "";
  export let addBaseSkill;
  export let removeBaseSkill;
  export let resetBaseSkills;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-robot opacity-50 mr-1"></i> Subagent / CodeAct
</h3>
<p class="text-xs opacity-50 mb-3">CodeAct 执行引擎和注意力系统参数。</p>
{#if config.subagent}
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 最大 Sandbox</span
      >
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.subagent.maxSandboxInstances}
        placeholder="5"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">空闲超时 (ms)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.subagent.sandboxIdleTimeout}
        placeholder="600000"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">轮询间隔 (ms)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.subagent.pollInterval}
        placeholder="5000"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">Alert 阈值</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.subagent.alertEngagementThreshold}
        placeholder="60"
      /></label
    >
  </div>
  <div class="divider text-xs opacity-50 my-3">CodeAct</div>
  <div class="cfg-grid-3">
    <label class="cfg-field"
      ><span class="cfg-label">最大轮次</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        value={config.subagent.codeAct?.maxTurns ?? ""}
        on:input={(e) => {
          if (!config.subagent.codeAct) config.subagent.codeAct = {};
          config.subagent.codeAct.maxTurns = Number(e.target.value) || undefined;
          config = config;
        }}
        placeholder="30"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">执行超时 (ms)</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        value={config.subagent.codeAct?.maxExecutionTimeMs ?? ""}
        on:input={(e) => {
          if (!config.subagent.codeAct) config.subagent.codeAct = {};
          config.subagent.codeAct.maxExecutionTimeMs = Number(e.target.value) || undefined;
          config = config;
        }}
        placeholder="60000"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">最大消息</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        value={config.subagent.codeAct?.maxSessionMessages ?? ""}
        on:input={(e) => {
          if (!config.subagent.codeAct) config.subagent.codeAct = {};
          config.subagent.codeAct.maxSessionMessages = Number(e.target.value) || undefined;
          config = config;
        }}
        placeholder="100"
      /></label
    >
  </div>
  <div class="divider text-xs opacity-50 my-3"><i class="fa-solid fa-puzzle-piece mr-1"></i>常驻模块 (Base Skills)</div>
  <p class="text-xs opacity-40 mb-2">
    始终对 Subagent 可见的模块。平台 adapter（telegram/discord）会自动包含，无需在此列举。
  </p>
  <div class="flex flex-wrap gap-1.5 mb-2">
    {#each config.subagent.baseSkills || [] as sk}
      <span class="badge badge-sm badge-outline gap-1">
        {sk}
        <button class="btn btn-ghost btn-xs px-0" on:click={() => removeBaseSkill(sk)}>×</button>
      </span>
    {/each}
  </div>
  <div class="flex gap-1">
    <input
      type="text"
      class="input input-xs input-bordered flex-1"
      bind:value={newBaseSkill}
      placeholder="模块名…"
      on:keydown={(e) => e.key === "Enter" && addBaseSkill()}
    />
    <button class="btn btn-xs btn-outline btn-primary" on:click={addBaseSkill}>
      <i class="fa-solid fa-plus"></i> 添加
    </button>
    <button class="btn btn-xs btn-outline btn-ghost" on:click={resetBaseSkills} title="重置为默认值">
      <i class="fa-solid fa-rotate-left"></i>
    </button>
  </div>
{/if}
