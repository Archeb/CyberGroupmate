<script>
  export let config;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-globe opacity-50 mr-1"></i> Grounding (联网事实查证)
</h3>
<p class="text-xs opacity-50 mb-3">
  在主 Agent 决策时并行查询真实世界信息，用于事实查证和知识补充。配置后将自动在 attend 阶段并行触发。
</p>

<div class="cfg-grid-2">
  <label class="cfg-field">
    <span class="cfg-label">搜索引擎</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.grounding.provider}
    >
      <option value="google">Google (Gemini)</option>
      <option value="grok">Grok (xAI)</option>
    </select>
  </label>

  <label class="cfg-field">
    <span class="cfg-label">API Key</span>
    <input
      type="password"
      class="input input-xs input-bordered w-full"
      bind:value={config.grounding.apiKey}
      placeholder="输入 API Key"
      on:focus={pwFocus}
      on:blur={pwBlur}
    />
  </label>

  <label class="cfg-field">
    <span class="cfg-label">Base URL <span class="opacity-40">(可选)</span></span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.grounding.baseUrl}
      placeholder={config.grounding.provider === 'grok' ? 'https://api.x.ai/v1' : '(Google 无需设置)'}
    />
  </label>

  <label class="cfg-field">
    <span class="cfg-label">模型 <span class="opacity-40">(可选)</span></span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.grounding.model}
      placeholder={config.grounding.provider === 'grok' ? 'grok-3-mini-fast' : 'gemini-2.0-flash-lite'}
    />
  </label>
</div>

<div class="mt-3 p-2 rounded bg-base-200 text-xs opacity-60">
  <i class="fa-solid fa-circle-info mr-1"></i>
  {#if config.grounding.provider === 'google'}
    使用 <b>Gemini API</b> 的原生 Google Search Grounding 工具。需在 <a href="https://aistudio.google.com/apikey" target="_blank" class="link">AI Studio</a> 获取 API Key。
  {:else}
    使用 <b>xAI Grok</b> 的 Web Search 工具（Responses API）。需在 <a href="https://console.x.ai" target="_blank" class="link">xAI Console</a> 获取 API Key。
  {/if}
</div>
