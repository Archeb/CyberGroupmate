<script>
  export let config;
  export let telegramEnabled = false;
  export let pwFocus;
  export let pwBlur;
  import MonacoEditor from "../../components/MonacoEditor.svelte";
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
        <option value="bot">bot</option><option value="userbot">userbot</option>
      </select></label
    >
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
  </div>
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
  <div class="divider text-xs opacity-50 my-3">
    入站白名单 <span class="restart-hint"
      ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
    >
  </div>
  <p class="text-xs opacity-50 mb-2">启用后仅处理列表中的群组或私聊；私聊按对方用户 ID 匹配。</p>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.telegram.whitelist.enabled}
    />
    <span>启用白名单</span>
  </label>
  <div class="cfg-grid-2">
    <div class="cfg-field col-span-2"
      ><span class="cfg-label">群组 ID（每行一个，如 -1001234567890）</span>
      <MonacoEditor
        language="plaintext"
        height={120}
        value={config.telegram.whitelist.groups.join("\n")}
        on:change={(e) => {
          config.telegram.whitelist.groups = e.detail.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      /></div
    >
    <div class="cfg-field col-span-2"
      ><span class="cfg-label">私聊用户 ID（每行一个）</span>
      <MonacoEditor
        language="plaintext"
        height={120}
        value={config.telegram.whitelist.users.join("\n")}
        on:change={(e) => {
          config.telegram.whitelist.users = e.detail.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      /></div
    >
  </div>
</div>
