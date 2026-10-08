<script>
  export let config;
  export let feishuEnabled = false;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-comments opacity-50 mr-1"></i> 飞书 / Lark 设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={feishuEnabled}
  />
  <span class="text-sm font-medium">启用飞书 / Lark Adapter</span>
  <i class="fa-solid fa-rotate-right restart-icon"></i>
</label>
{#if !feishuEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<fieldset disabled={!feishuEnabled} class:opacity-40={!feishuEnabled}>
  <p class="text-xs opacity-50 mb-2">使用应用长连接接收事件。启停或修改连接参数后需重启服务。</p>
  <div class="alert alert-info py-2 px-3 mb-3 text-xs items-start">
    <i class="fa-solid fa-circle-info mt-0.5"></i>
    <span>
      请在开放平台启用机器人能力并订阅“接收消息”；交互卡片需订阅 <code>card.action.trigger</code>，表情感知需订阅消息表情增删事件。
      CardKit 动态更新需 <code>cardkit:card:write</code>；显示用户姓名还需通讯录基本用户信息权限和可见范围。
      离线补抓需要会话历史权限。机器人只能复用收到过的表情包，且飞书不提供机器人输入状态，也不支持机器人将收到的消息标记为已读。
    </span>
  </div>
  <div class="cfg-grid-2">
    <label class="cfg-field col-span-2">
      <span class="cfg-label"><i class="fa-solid fa-rotate-right restart-icon"></i> App ID</span>
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.feishu.appId}
        placeholder="App ID"
        required={feishuEnabled}
      />
    </label>
    <label class="cfg-field col-span-2">
      <span class="cfg-label"><i class="fa-solid fa-rotate-right restart-icon"></i> App Secret</span>
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.feishu.appSecret}
        placeholder="App Secret"
        autocomplete="new-password"
        required={feishuEnabled}
      />
    </label>
    <label class="cfg-field col-span-2">
      <span class="cfg-label"><i class="fa-solid fa-rotate-right restart-icon"></i> Domain</span>
      <select
        class="select select-xs select-bordered w-full"
        value={config.feishu.domain ?? 'feishu'}
        on:change={(event) => config.feishu.domain = event.target.value}
      >
        <option value="feishu">飞书 (feishu)</option>
        <option value="lark">Lark (lark)</option>
      </select>
    </label>
  </div>
</fieldset>
