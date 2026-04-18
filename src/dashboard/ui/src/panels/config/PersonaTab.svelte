<script>
  export let config;
  export let newKeyword = "";
  export let addKeyword;
  export let removeKeyword;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-user-astronaut opacity-50 mr-1"></i> 人格 & 唤醒
</h3>
<p class="text-xs opacity-50 mb-3">
  Agent 的名字、人格描述以及唤醒关键词，注入到所有 LLM system prompt。
</p>
<div class="cfg-grid-2 mb-4">
  <label class="cfg-field col-span-2"
    ><span class="cfg-label">Agent 名字</span>
    <input
      type="text"
      class="input input-sm input-bordered w-full"
      bind:value={config.persona.name}
    /></label
  >
</div>
<label class="cfg-field mb-4"
  ><span class="cfg-label">人格描述</span>
  <textarea
    class="textarea textarea-bordered w-full"
    rows="8"
    bind:value={config.persona.description}
  ></textarea></label
>

<div class="divider text-xs opacity-50 my-2">
  <i class="fa-solid fa-bell mr-1"></i>唤醒关键词
</div>
<p class="text-xs opacity-50 mb-2">
  消息包含这些关键词时立即触发处理（@提及 / 名字唤醒）。
</p>
<div class="flex flex-wrap gap-1 mb-2">
  {#each config.notification.mentionKeywords as kw}
    <div class="badge badge-outline badge-sm gap-1">
      {kw}
      <button
        class="btn btn-ghost btn-xs px-0 min-h-0 h-auto"
        on:click={() => removeKeyword(kw)}
        aria-label="移除关键词"
      >
        <i class="fa-solid fa-xmark text-[10px]"></i>
      </button>
    </div>
  {/each}
</div>
<div class="flex gap-2">
  <input
    type="text"
    class="input input-sm input-bordered flex-1"
    bind:value={newKeyword}
    placeholder="输入关键词..."
    on:keydown={(e) => e.key === "Enter" && addKeyword()}
  />
  <button class="btn btn-sm btn-primary" on:click={addKeyword} aria-label="添加关键词"
    ><i class="fa-solid fa-plus"></i></button
  >
</div>
