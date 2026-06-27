<script>
  import MonacoEditor from "../../components/MonacoEditor.svelte";
  export let config;
  export let profileTests = {};
  export let expandedProfiles;
  export let showNewProfile = false;
  export let newProfileName = "";
  export let testProfile;
  export let cloneProfile;
  export let deleteProfile;
  export let pwFocus;
  export let pwBlur;
  export let addProfile;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-microchip opacity-50 mr-1"></i> LLM Profiles
</h3>
<p class="text-xs opacity-50 mb-3">
  定义命名 LLM 配置（provider / key / model），在组件路由中引用。
</p>
{#each Object.entries(config.llmProfiles) as [name, p]}
  <div class="profile-card">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flex justify-between items-center cursor-pointer select-none"
      on:click={() => {
        expandedProfiles.has(name) ? expandedProfiles.delete(name) : expandedProfiles.add(name);
        expandedProfiles = expandedProfiles;
      }}
    >
      <div class="flex items-center gap-2 min-w-0">
        <i class="fa-solid fa-chevron-right text-xs opacity-40 transition-transform" style:transform={expandedProfiles.has(name) ? "rotate(90deg)" : ""}></i>
        <h4 class="font-mono font-bold text-sm truncate">{name}</h4>
        <span class="text-xs opacity-40 truncate hidden sm:inline">
          {p.provider}{p.model ? ` · ${p.model}` : ""}{p.baseUrl ? ` · ${p.baseUrl.replace(/^https?:\/\//, "").slice(0, 30)}` : ""}
        </span>
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="flex gap-1 flex-shrink-0" on:click|stopPropagation>
        <button
          class="btn btn-xs btn-outline btn-info"
          on:click={() => testProfile(name)}
          disabled={profileTests[name]?.testing}
          title="测试连通性"
        >
          <i class="fa-solid fa-plug"></i>
          {profileTests[name]?.testing ? "..." : "测试"}
        </button>
        <button
          class="btn btn-xs btn-outline"
          on:click={() => cloneProfile(name)}
          title="复制 Profile"
        >
          <i class="fa-solid fa-copy"></i>
        </button>
        <button
          class="btn btn-xs btn-outline btn-error"
          on:click={() => deleteProfile(name)}
          title="删除"
        >
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    </div>
    {#if profileTests[name] && !profileTests[name].testing}
      <div
        class="alert alert-sm mb-2 mt-2 py-1"
        class:alert-success={profileTests[name].ok}
        class:alert-error={!profileTests[name].ok}
      >
        <span class="text-xs">
          {profileTests[name].ok
            ? `✅ ${profileTests[name].latency}ms · model: ${profileTests[name].model || "?"}`
            : `❌ ${profileTests[name].error || `HTTP ${profileTests[name].status}`}`}
        </span>
      </div>
    {/if}
    {#if expandedProfiles.has(name)}
      <div class="mt-3">
        <div class="cfg-grid-2">
          <label class="cfg-field"
            ><span class="cfg-label">Provider</span>
            <select class="select select-xs select-bordered w-full" bind:value={p.provider}>
              <option value="openai">openai (兼容)</option><option value="openai_responses">openai (responses)</option><option value="anthropic">anthropic</option><option value="google">google (Gemini)</option>
            </select></label
          >
          <label class="cfg-field"
            ><span class="cfg-label">Model</span>
            <input type="text" class="input input-xs input-bordered w-full" bind:value={p.model} placeholder="gpt-4o" /></label
          >
          <label class="cfg-field col-span-2"
            ><span class="cfg-label">Base URL</span>
            <input type="text" class="input input-xs input-bordered w-full" bind:value={p.baseUrl} placeholder="https://api.openai.com/v1" /></label
          >
          <label class="cfg-field col-span-2"
            ><span class="cfg-label">API Key</span>
            <input type="password" class="input input-xs input-bordered w-full" bind:value={p.apiKey} on:focus={pwFocus} on:blur={pwBlur} /></label
          >
          <label class="cfg-field"><span class="cfg-label">Temperature</span><input type="number" class="input input-xs input-bordered w-full" bind:value={p.temperature} min="0" max="2" step="0.1" /></label>
          <label class="cfg-field"><span class="cfg-label">Max Tokens</span><input type="number" class="input input-xs input-bordered w-full" bind:value={p.maxTokens} min="1" /></label>
          <label class="cfg-field"><span class="cfg-label">Max Context Tokens</span><input type="number" class="input input-xs input-bordered w-full" bind:value={p.maxContextTokens} placeholder="(默认)" /></label>
          <label class="cfg-field"><span class="cfg-label">Thinking Level</span>
            <select class="select select-xs select-bordered w-full" bind:value={p.thinkingLevel}>
              <option value={undefined}>无</option><option value="none">none</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select></label>
          <label class="cfg-check"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={p.vision} /><span>Vision</span></label>
          <label class="cfg-check"><input
              type="checkbox"
              class="checkbox checkbox-xs"
              checked={p.supportsPrefill !== false}
              on:change={(e) => {
                p.supportsPrefill = e.target.checked ? undefined : false;
                config = config;
              }}
            /><span>Prefill</span></label>
        </div>
        {#if p.provider === "openai_responses"}
          <div class="cfg-grid-2 mt-2">
            <label class="cfg-field"><span class="cfg-label">Responses 请求模式</span>
              <select class="select select-xs select-bordered w-full" bind:value={p.responsesRequestMode}>
                <option value="non_stream">non_stream（默认）</option>
                <option value="stream">stream（后台聚合完整输出）</option>
              </select>
            </label>
          </div>
        {/if}
        {#if p.provider === "google"}
          <div class="divider text-xs opacity-50 my-2"><i class="fa-brands fa-google mr-1"></i>Vertex AI 设置（可选）</div>
          <p class="text-xs opacity-40 mb-2">粘贴服务账号 JSON 密钥后自动启用 Vertex AI 模式。留空则使用 AI Studio（需填 API Key）。</p>
          <div class="cfg-field"><span class="cfg-label">服务账号 JSON 密钥</span>
            <MonacoEditor
              language="json"
              height={150}
              value={p.vertexCredentials ? JSON.stringify(p.vertexCredentials, null, 2) : ""}
              on:blur={(e) => {
                const val = e.detail.value.trim();
                if (!val) {
                  p.vertexCredentials = undefined;
                } else {
                  try {
                    p.vertexCredentials = JSON.parse(val);
                  } catch {
                    // ignore
                  }
                }
                config = config;
              }}
            />
          </div>
          <div class="cfg-grid-2 mt-1">
            <label class="cfg-field"><span class="cfg-label">Project 覆盖 <span class="opacity-40">(可选)</span></span><input type="text" class="input input-xs input-bordered w-full" bind:value={p.vertexProject} placeholder={p.vertexCredentials?.project_id || "自动从 JSON 提取"} /></label>
            <label class="cfg-field"><span class="cfg-label">Region</span><input type="text" class="input input-xs input-bordered w-full" bind:value={p.vertexRegion} placeholder="global" /></label>
          </div>
        {/if}
        {#if p.provider === "openai" || p.provider === "openai_responses" || p.provider === "anthropic"}
          <div class="divider text-xs opacity-50 my-2"><i class="fa-solid fa-plus-circle mr-1"></i>Extra Body & Headers（可选）</div>
          <p class="text-xs opacity-40 mb-2">额外请求体字段和自定义请求头，JSON 对象格式。会被展开合并到对应的 API 请求中。</p>
          <div class="cfg-field"><span class="cfg-label">Extra Body (JSON)</span>
            <MonacoEditor
              language="json"
              height={132}
              value={p.extraBody ? JSON.stringify(p.extraBody, null, 2) : ""}
              on:blur={(e) => {
                const val = e.detail.value.trim();
                if (!val) {
                  p.extraBody = undefined;
                  p._extraBodyError = undefined;
                } else {
                  try {
                    const parsed = JSON.parse(val);
                    if (typeof parsed !== "object" || Array.isArray(parsed)) {
                      p._extraBodyError = "必须是 JSON 对象（不能是数组或基本类型）";
                    } else {
                      p.extraBody = parsed;
                      p._extraBodyError = undefined;
                    }
                  } catch (err) {
                    p._extraBodyError = "JSON 格式错误: " + err.message;
                  }
                }
                config = config;
              }}
            />
          </div>
          {#if p._extraBodyError}
            <div class="text-xs text-error mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>{p._extraBodyError}</div>
          {/if}
          <div class="cfg-field mt-2"><span class="cfg-label">Custom Headers (JSON)</span>
            <MonacoEditor
              language="json"
              height={132}
              value={p.customHeaders ? JSON.stringify(p.customHeaders, null, 2) : ""}
              on:blur={(e) => {
                const val = e.detail.value.trim();
                if (!val) {
                  p.customHeaders = undefined;
                  p._customHeadersError = undefined;
                } else {
                  try {
                    const parsed = JSON.parse(val);
                    if (typeof parsed !== "object" || Array.isArray(parsed)) {
                      p._customHeadersError = "必须是 JSON 对象";
                    } else {
                      p.customHeaders = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
                      p._customHeadersError = undefined;
                    }
                  } catch (err) {
                    p._customHeadersError = "JSON 格式错误: " + err.message;
                  }
                }
                config = config;
              }}
            />
          </div>
          {#if p._customHeadersError}
            <div class="text-xs text-error mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>{p._customHeadersError}</div>
          {/if}
        {/if}
        <div class="divider text-xs opacity-50 my-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>错误内容检测（Fallback）</div>
        <p class="text-xs opacity-40 mb-2">每行一个关键词。若响应文本包含任意关键词，将视为失败并触发 fallback（用于某些返回 200 但内容是错误信息的 API）。</p>
        <div class="cfg-field"><span class="cfg-label">Error Content Patterns (one per line)</span>
          <MonacoEditor
            language="plaintext"
            height={132}
            value={(p.errorContentPatterns || []).join("\n")}
            on:blur={(e) => {
              const lines = e.detail.value
                .split(/\r?\n/)
                .map((x) => x.trim())
                .filter(Boolean);
              p.errorContentPatterns = lines.length ? lines : undefined;
              config = config;
            }}
          />
        </div>
        <div class="divider text-xs opacity-50 my-2"><i class="fa-solid fa-comment-dots mr-1"></i>回复提示词（可选）</div>
        <p class="text-xs opacity-40 mb-2">仅在生成回复时追加到 prompt 末尾的补充提示词（如微调语气、格式）；不改动 system prompt / persona，留空则不注入。</p>
        <div class="cfg-field">
          <span class="cfg-label">回复提示词 (reply_prompt)</span>
          <textarea
            class="textarea textarea-xs textarea-bordered w-full font-mono text-xs"
            rows="4"
            placeholder="（可选）仅在生成回复时附加的提示词……"
            value={p.replyPrompt ?? ""}
            on:input={(e) => {
              p.replyPrompt = e.target.value || undefined;
              config = config;
            }}
          ></textarea>
        </div>
        <div class="divider text-xs opacity-50 my-2"><i class="fa-solid fa-coins mr-1"></i>Pricing（可选）</div>
        <p class="text-xs opacity-40 mb-2">每百万 token 的价格（美元），用于 token 消耗统计。留空则不计费。</p>
        <div class="cfg-grid-2">
          <label class="cfg-field"><span class="cfg-label">Input ($/M)</span><input type="number" class="input input-xs input-bordered w-full" value={p.pricing?.input ?? ""} on:input={(e) => { if (!p.pricing) p.pricing = {}; p.pricing.input = e.target.value ? Number(e.target.value) : undefined; config = config; }} placeholder="0" min="0" step="0.01" /></label>
          <label class="cfg-field"><span class="cfg-label">Output ($/M)</span><input type="number" class="input input-xs input-bordered w-full" value={p.pricing?.output ?? ""} on:input={(e) => { if (!p.pricing) p.pricing = {}; p.pricing.output = e.target.value ? Number(e.target.value) : undefined; config = config; }} placeholder="0" min="0" step="0.01" /></label>
          <label class="cfg-field"><span class="cfg-label">Cached Input ($/M)</span><input type="number" class="input input-xs input-bordered w-full" value={p.pricing?.cachedInput ?? ""} on:input={(e) => { if (!p.pricing) p.pricing = {}; p.pricing.cachedInput = e.target.value ? Number(e.target.value) : undefined; config = config; }} placeholder="(可选)" min="0" step="0.01" /></label>
          <label class="cfg-field"><span class="cfg-label">Cache Creation ($/M)</span><input type="number" class="input input-xs input-bordered w-full" value={p.pricing?.cacheCreation ?? ""} on:input={(e) => { if (!p.pricing) p.pricing = {}; p.pricing.cacheCreation = e.target.value ? Number(e.target.value) : undefined; config = config; }} placeholder="(可选)" min="0" step="0.01" /></label>
        </div>
      </div>
    {/if}
  </div>
{/each}
<div class="flex items-center gap-2 mt-2">
  {#if showNewProfile}
    <input
      type="text"
      class="input input-sm input-bordered"
      bind:value={newProfileName}
      placeholder="名称"
      on:keydown={(e) => e.key === "Enter" && addProfile()}
    />
    <button class="btn btn-sm btn-primary" on:click={addProfile}>添加</button>
    <button class="btn btn-sm btn-ghost" on:click={() => (showNewProfile = false)}>取消</button>
  {:else}
    <button class="btn btn-sm btn-outline btn-primary" on:click={() => (showNewProfile = true)}>
      <i class="fa-solid fa-plus"></i> 新建 Profile
    </button>
  {/if}
</div>
