<script>
  export let config;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-sliders opacity-50 mr-1"></i> Context Budget
</h3>
<p class="text-xs opacity-50 mb-3">
  上下文压缩的 token 预算分配。留空使用默认值。
</p>
<div class="cfg-grid-2">
  <label class="cfg-field"
    ><span class="cfg-label">有效上下文窗口 (tokens)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.contextBudget.effectiveContextWindow}
      placeholder="32000"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">OutputReserve (tokens)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.contextBudget.outputReserve}
      placeholder="4096"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">System Prompt 比例</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.contextBudget.systemPromptRatio}
      placeholder="0.20"
      step="0.05"
      min="0"
      max="1"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">Briefing 比例</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.contextBudget.briefingRatio}
      placeholder="0.15"
      step="0.05"
      min="0"
      max="1"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">近期消息比例</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.contextBudget.recentHistoryRatio}
      placeholder="0.50"
      step="0.05"
      min="0"
      max="1"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">最少保留消息</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.contextBudget.minRecentMessages}
      placeholder="6"
    /></label
  >
  <label class="cfg-field col-span-2"
    ><span class="cfg-label">Briefing 最大 tokens</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.contextBudget.maxBriefingTokens}
      placeholder="3000"
    /></label
  >
</div>
