<script>
  export let config;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-vector-square opacity-50 mr-1"></i>
  Embedding
  <span class="restart-hint"
    ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
  >
</h3>
<p class="text-xs opacity-50 mb-3">
  向量化提供者。切换后已有向量数据可能不兼容。
</p>
<div class="cfg-grid-2">
  <label class="cfg-field"
    ><span class="cfg-label">Provider</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.embedding.provider}
    >
      <option value="local">local (本地 hash)</option><option
        value="openai">openai (API)</option
      >
    </select></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">相似度</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.embedding.similarityMetric}
    >
      <option value="cosine">cosine</option><option
        value="dot_product">dot_product</option
      >
      <option value="euclidean">euclidean</option><option
        value="manhattan">manhattan</option
      >
    </select></label
  >
  {#if config.embedding.provider === "openai"}
    <label class="cfg-field col-span-2"
      ><span class="cfg-label">Base URL</span>
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.embedding.baseUrl}
      /></label
    >
    <label class="cfg-field col-span-2"
      ><span class="cfg-label">API Key</span>
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.embedding.apiKey}
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">Model</span>
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.embedding.model}
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">Dimensions</span>
      <input
        type="number"
        class="input input-xs input-bordered w-full"
        bind:value={config.embedding.dimensions}
      /></label
    >
  {/if}
</div>
