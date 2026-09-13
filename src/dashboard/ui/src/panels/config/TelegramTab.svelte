<script>
  export let config;
  export let telegramEnabled = false;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-paper-plane opacity-50 mr-1"></i> Telegram 设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={telegramEnabled}
  />
  <span class="text-sm font-medium">启用 Telegram Adapter</span>
</label>
{#if !telegramEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!telegramEnabled} class:pointer-events-none={!telegramEnabled}>
  <p class="text-xs opacity-50 mb-3">连接参数和发送行为。</p>
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 连接模式</span
      >
      <select
        class="select select-xs select-bordered w-full"
        bind:value={config.telegram.mode}
      >
        <option value="bot_api">机器人（Bot API）</option>
        <option value="bot">机器人（MTProto）</option>
        <option value="userbot">用户账号（MTProto）</option>
      </select></label
    >
    {#if config.telegram.mode !== 'userbot'}
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot Token</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.botToken}
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    {/if}
    {#if config.telegram.mode !== 'bot_api'}
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> API ID</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.apiId}
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> API Hash</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.apiHash}
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    {/if}
    {#if config.telegram.mode === 'userbot'}
    <label class="cfg-field col-span-2"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 手机号 (userbot)</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.phone}
        placeholder="+86..."
      /></label
    >
    {/if}
  </div>
  {#if config.telegram.mode === 'bot_api'}
    <p class="text-xs opacity-60 mt-2">仅需 BotFather 签发的 Token。通过长轮询接收消息，需先手动移除已有 webhook。群消息受 Telegram 隐私模式限制；不支持历史查询、用户登录及 MTProto 原生方法。</p>
  {:else}
    <p class="text-xs opacity-60 mt-2">MTProto 连接需要 Telegram API ID 和 API Hash。机器人另需 Token；用户账号使用手机号、验证码及可选的两步验证密码登录。</p>
  {/if}
  <div class="divider text-xs opacity-50 my-3">拟人化发送延迟</div>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.telegram.humanizedDelay.enabled}
    />
    <span>启用拟人化延迟</span>
  </label>
  {#if config.telegram.humanizedDelay.enabled}
    <div class="cfg-grid-3">
      <label class="cfg-field"
        ><span class="cfg-label">每字符 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.msPerChar}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最小 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.minDelay}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最大 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.maxDelay}
        /></label
      >
    </div>
  {/if}
</div>
