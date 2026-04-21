<script>
  export let config;
  export let onebotEnabled = false;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-comments opacity-50 mr-1"></i> QQ / OneBot 设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={onebotEnabled}
  />
  <span class="text-sm font-medium">启用 OneBot Adapter</span>
</label>
{#if !onebotEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!onebotEnabled} class:pointer-events-none={!onebotEnabled}>
  <p class="text-xs opacity-50 mb-3">通过 OneBot v11 协议连接 NapCat / go-cqhttp 等 QQ 框架。</p>
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> WebSocket 地址</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full font-mono"
        bind:value={config.onebot.wsUrl}
        placeholder="ws://127.0.0.1:3001"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot QQ 号</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full font-mono"
        bind:value={config.onebot.selfId}
        placeholder="123456789"
      /></label
    >
  </div>
  <div class="divider text-xs opacity-50 my-3">拟人化发送延迟</div>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.onebot.humanizedDelay.enabled}
    />
    <span>启用拟人化延迟</span>
  </label>
  {#if config.onebot.humanizedDelay.enabled}
    <div class="cfg-grid-3">
      <label class="cfg-field"
        ><span class="cfg-label">每字符 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.onebot.humanizedDelay.msPerChar}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最小 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.onebot.humanizedDelay.minDelay}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最大 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.onebot.humanizedDelay.maxDelay}
        /></label
      >
    </div>
  {/if}
  <div class="divider text-xs opacity-50 my-3">
    入站白名单 <span class="restart-hint"
      ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
    >
  </div>
  <p class="text-xs opacity-50 mb-2">启用后仅处理列表中的群聊或私聊；私聊按对方 QQ 号匹配。</p>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.onebot.whitelist.enabled}
    />
    <span>启用白名单</span>
  </label>
  <div class="cfg-grid-2">
    <label class="cfg-field col-span-2"
      ><span class="cfg-label">群号（每行一个）</span>
      <textarea
        class="textarea textarea-bordered textarea-xs w-full font-mono min-h-[4rem]"
        value={config.onebot.whitelist.groups.join("\n")}
        on:input={(e) => {
          config.onebot.whitelist.groups = e.target.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      ></textarea></label
    >
    <label class="cfg-field col-span-2"
      ><span class="cfg-label">私聊 QQ 号（每行一个）</span>
      <textarea
        class="textarea textarea-bordered textarea-xs w-full font-mono min-h-[4rem]"
        value={config.onebot.whitelist.users.join("\n")}
        on:input={(e) => {
          config.onebot.whitelist.users = e.target.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      ></textarea></label
    >
  </div>
</div>
