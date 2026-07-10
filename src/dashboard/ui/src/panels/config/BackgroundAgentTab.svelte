<script>
  export let config;
  export let pwFocus;
  export let pwBlur;

  if (!config.backgroundAgent) config.backgroundAgent = {};

  let extraArgsText = (config.backgroundAgent.extraArgs ?? []).join(" ");
  $: config.backgroundAgent.extraArgs = extraArgsText.trim()
    ? extraArgsText.trim().split(/\s+/)
    : undefined;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-moon opacity-50 mr-1"></i> Background Agent
</h3>
<p class="text-xs opacity-50 mb-3">
  做梦系统配置。MCP Server 暴露内部 API 给外部 harness（Claude Code / Codex CLI / Copilot CLI），harness 在后台执行任务。
</p>

<div class="cfg-grid-3">
  <label class="cfg-check">
    <input type="checkbox" class="toggle toggle-xs" bind:checked={config.backgroundAgent.enabled} />
    <span>启用 MCP Server</span>
  </label>
  <label class="cfg-field">
    <span class="cfg-label">MCP 端口</span>
    <input type="number" class="input input-xs input-bordered w-full"
      bind:value={config.backgroundAgent.mcpPort} placeholder="3100" />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">MCP Token</span>
    <input type="password" class="input input-xs input-bordered w-full"
      bind:value={config.backgroundAgent.mcpToken} placeholder="(随机生成)"
      on:focus={pwFocus} on:blur={pwBlur} />
  </label>
</div>

<div class="divider text-xs opacity-50 my-2">Harness</div>

<div class="cfg-grid-3">
  <label class="cfg-field">
    <span class="cfg-label">Harness 类型</span>
    <select class="select select-xs select-bordered w-full" bind:value={config.backgroundAgent.harness}>
      <option value={undefined}>不启用</option>
      <option value="claude-code">Claude Code</option>
      <option value="codex">Codex CLI</option>
      <option value="copilot">Copilot CLI</option>
    </select>
  </label>
  <label class="cfg-field">
    <span class="cfg-label">模型</span>
    <input type="text" class="input input-xs input-bordered w-full"
      bind:value={config.backgroundAgent.harnessModel}
      placeholder={config.backgroundAgent.harness === "claude-code" ? "claude-sonnet-4-6" : "gpt-5.2"} />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">单次预算 (USD)</span>
    <input type="number" class="input input-xs input-bordered w-full" step="0.5"
      bind:value={config.backgroundAgent.maxBudgetUsd} placeholder="5" />
  </label>
</div>

<div class="cfg-grid-3 mt-2">
  {#if config.backgroundAgent.harness === "claude-code"}
    <label class="cfg-field">
      <span class="cfg-label">Claude CLI 路径</span>
      <input type="text" class="input input-xs input-bordered w-full"
        bind:value={config.backgroundAgent.claudeCodePath} placeholder="claude" />
    </label>
  {:else if config.backgroundAgent.harness === "codex"}
    <label class="cfg-field">
      <span class="cfg-label">Codex CLI 路径</span>
      <input type="text" class="input input-xs input-bordered w-full"
        bind:value={config.backgroundAgent.codexPath} placeholder="codex" />
    </label>
  {:else if config.backgroundAgent.harness === "copilot"}
    <label class="cfg-field">
      <span class="cfg-label">Copilot CLI 路径</span>
      <input type="text" class="input input-xs input-bordered w-full"
        bind:value={config.backgroundAgent.copilotPath} placeholder="copilot" />
    </label>
  {/if}
  <label class="cfg-field">
    <span class="cfg-label">定时 Schedule (cron)</span>
    <input type="text" class="input input-xs input-bordered w-full"
      bind:value={config.backgroundAgent.schedule} placeholder="0 3 * * *" />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">强制最小间隔 (小时)</span>
    <input type="number" class="input input-xs input-bordered w-full" min="0" step="1"
      bind:value={config.backgroundAgent.minIntervalHours} placeholder="6" />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">自定义启动参数</span>
    <input type="text" class="input input-xs input-bordered w-full"
      bind:value={extraArgsText} placeholder="--verbose --flag=value" />
  </label>
</div>
<p class="text-xs opacity-50 mt-1">
  强制最小间隔：距上次做梦不足该小时数时，定时触发会被跳过；防重启/cron 边界/重试叠加导致频繁做梦。设 0 关闭。
</p>
