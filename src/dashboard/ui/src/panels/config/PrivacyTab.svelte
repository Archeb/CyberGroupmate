<script>
  export let config;

  let newChat = "";

  function addChat() {
    const c = newChat.trim();
    if (!c) return;
    if (!config.privacy.sensitiveChats) config.privacy.sensitiveChats = [];
    if (!config.privacy.sensitiveChats.includes(c)) {
      config.privacy.sensitiveChats = [...config.privacy.sensitiveChats, c];
    }
    newChat = "";
  }
  function removeChat(c) {
    config.privacy.sensitiveChats = config.privacy.sensitiveChats.filter((x) => x !== c);
  }
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-shield-halved opacity-50 mr-1"></i> 全局隐私兜底
</h3>
<p class="text-xs opacity-50 mb-3">
  按会话隐私分级（私密 / 公开）统一兜底：bot 每一次跨会话的读写——查看别处的聊天记录 / 人物档案、跨会话发送或 dispatch、记忆召回——都会受控，
  避免把私密群 / 私聊的内容带到无关会话。
</p>

<div class="cfg-grid-2">
  <label class="cfg-field">
    <span class="cfg-label">越界处理 (enforce)</span>
    <select class="select select-xs select-bordered w-full" bind:value={config.privacy.enforce}>
      <option value="block">block — 拦截（推荐）</option>
      <option value="warn">warn — 仅日志/告警，不拦截</option>
      <option value="off">off — 关闭兜底</option>
    </select>
  </label>

  <label class="cfg-field justify-end">
    <span class="cfg-label">私聊 (DM)</span>
    <label class="cfg-check">
      <input type="checkbox" class="checkbox checkbox-xs" bind:checked={config.privacy.dmAutoPrivate} />
      <span>私聊自动判为私密</span>
    </label>
  </label>
</div>

<div class="mt-2">
  <label class="cfg-check">
    <input type="checkbox" class="checkbox checkbox-xs" bind:checked={config.privacy.allowLlmMarkSensitive} />
    <span>允许 bot 自行把会话加入私密名单</span>
  </label>
  <p class="text-xs opacity-40 mt-1 ml-6">
    关闭后私密名单只能由你手动维护，bot 不能自行收紧。
  </p>
</div>

<div class="divider text-xs opacity-50 my-2">
  <i class="fa-solid fa-user-secret mr-1"></i>敏感会话名单 (sensitive_chats)
</div>
<div class="flex flex-wrap gap-1 mb-2">
  {#each config.privacy.sensitiveChats ?? [] as c}
    <div class="badge badge-outline badge-sm gap-1">
      {c}
      <button
        class="btn btn-ghost btn-xs px-0 min-h-0 h-auto"
        on:click={() => removeChat(c)}
        aria-label="移除会话"
      >
        <i class="fa-solid fa-xmark text-[10px]"></i>
      </button>
    </div>
  {/each}
  {#if !(config.privacy.sensitiveChats?.length)}
    <span class="text-xs opacity-40">（空）默认仅私聊自动私密</span>
  {/if}
</div>
<div class="flex gap-2">
  <input
    type="text"
    class="input input-sm input-bordered flex-1"
    bind:value={newChat}
    placeholder="telegram:-1001234567890 / onebot:private:123456789"
    on:keydown={(e) => e.key === "Enter" && addChat()}
  />
  <button class="btn btn-sm btn-primary" on:click={addChat}>
    <i class="fa-solid fa-plus"></i> 添加
  </button>
</div>
