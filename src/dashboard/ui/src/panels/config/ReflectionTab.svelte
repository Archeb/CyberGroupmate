<script>
  export let config;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-brain opacity-50 mr-1"></i> 反思引擎
</h3>
<p class="text-xs opacity-50 mb-3">反思引擎的触发条件、时间参数和渐进合并。</p>
<div class="cfg-grid-2">
  <label class="cfg-field"
    ><span class="cfg-label">冷场阈值 (秒)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.reflection.silenceThreshold}
      placeholder="7200"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">最大间隔 (秒)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.reflection.maxInterval}
      placeholder="86400"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">检查间隔 (秒)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.reflection.checkInterval}
      placeholder="300"
    /></label
  >
</div>
<div class="divider text-xs opacity-50 my-3">渐进合并阈值 (天)</div>
<div class="cfg-grid-2">
  <label class="cfg-field"
    ><span class="cfg-label">Episode → Week</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.reflection.mergeThresholds.episodeToWeek}
      placeholder="7"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">Week → Month</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.reflection.mergeThresholds.weekToMonth}
      placeholder="30"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">Month → Quarter</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.reflection.mergeThresholds.monthToQuarter}
      placeholder="90"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">Quarter → Year</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.reflection.mergeThresholds.quarterToYear}
      placeholder="365"
    /></label
  >
</div>
<div class="divider text-xs opacity-50 my-3">作息时间</div>
<div class="cfg-grid-2">
  <label class="cfg-field"
    ><span class="cfg-label">起始小时</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      value={config.reflection.awakeHours?.[0] ?? ""}
      on:input={(e) => {
        if (!config.reflection.awakeHours) config.reflection.awakeHours = [8, 24];
        config.reflection.awakeHours[0] = Number(e.target.value);
        config = config;
      }}
      placeholder="8"
      min="0"
      max="23"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">结束小时</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      value={config.reflection.awakeHours?.[1] ?? ""}
      on:input={(e) => {
        if (!config.reflection.awakeHours) config.reflection.awakeHours = [8, 24];
        config.reflection.awakeHours[1] = Number(e.target.value);
        config = config;
      }}
      placeholder="24"
      min="0"
      max="24"
    /></label
  >
</div>
