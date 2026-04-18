<script>
  export let config;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-tape opacity-50 mr-1"></i> Recording Pipeline
</h3>
<p class="text-xs opacity-50 mb-3">
  话题聚类 Pipeline 的缓冲区和刷新触发参数。控制消息积攒到何种程度才进行一次 LLM 话题分析。
</p>
<div class="cfg-grid-2">
  <label class="cfg-field"
    ><span class="cfg-label">最少消息数</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.recordingPipeline.minFlushSize}
      placeholder="10"
      min="1"
    /><span class="text-[10px] opacity-40">静默到期时 buffer 不足此数则跳过 flush</span></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">正常阈值 (条)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.recordingPipeline.normalThreshold}
      placeholder="50"
      min="5"
    /><span class="text-[10px] opacity-40">消息积攒到此数立即 flush</span></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">加速阈值 (条)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.recordingPipeline.eagerThreshold}
      placeholder="15"
      min="3"
    /><span class="text-[10px] opacity-40">检测到强信号后的降低阈值</span></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">正常静默 (ms)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.recordingPipeline.normalSilenceMs}
      placeholder="120000"
      min="10000"
      step="10000"
    /><span class="text-[10px] opacity-40">无新消息多久后触发 flush（默认 2 分钟）</span></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">加速静默 (ms)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.recordingPipeline.eagerSilenceMs}
      placeholder="30000"
      min="5000"
      step="5000"
    /><span class="text-[10px] opacity-40">强信号模式下的静默触发时间（默认 30 秒）</span></label
  >
</div>
