<script>
  export let config;
  export let discordEnabled = false;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-gamepad opacity-50 mr-1"></i> Discord 设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={discordEnabled}
  />
  <span class="text-sm font-medium">启用 Discord Adapter</span>
</label>
{#if !discordEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!discordEnabled} class:pointer-events-none={!discordEnabled}>
  <p class="text-xs opacity-50 mb-3">Bot 连接参数。修改后需重启服务。</p>
  <div class="cfg-grid-2">
    <label class="cfg-field col-span-2"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot Token</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.discord.botToken}
        placeholder="Discord Bot Token"
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    <label class="cfg-field col-span-2"
      ><span class="cfg-label">Application ID</span>
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.discord.applicationId}
        placeholder="(可选)"
      /></label
    >
  </div>
</div>
