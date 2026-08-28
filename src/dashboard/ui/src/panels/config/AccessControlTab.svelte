<script>
  import { onMount } from "svelte";
  import MonacoEditor from "../../components/MonacoEditor.svelte";
  import { api } from "../../lib/api.js";

  export let config;

  $: if (!config.chatFilter) {
    config.chatFilter = {
      enabled: false,
      mode: "blacklist",
      chatIds: [],
      userIds: [],
    };
  }
  $: if (!config.chatFilter.chatIds) config.chatFilter.chatIds = [];
  $: if (!config.chatFilter.userIds) config.chatFilter.userIds = [];
  $: if (!config.chatFilter.allowedChatIds) config.chatFilter.allowedChatIds = [];
  $: if (!config.emergencyBlock) config.emergencyBlock = { message: "" };

  let invisibleText = "";
  let blockedText = "";
  let invisibleLoading = false;
  let blockedLoading = false;
  let invisibleSaved = false;
  let blockedSaved = false;

  const parseLines = (value) => value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  async function loadRuntimeLists() {
    const [invisible, blocked] = await Promise.allSettled([
      api("/invisible"),
      api("/blocked"),
    ]);
    if (invisible.status === "fulfilled") {
      invisibleText = (invisible.value.users ?? []).map((user) => user.userId).join("\n");
    }
    if (blocked.status === "fulfilled") {
      blockedText = (blocked.value.users ?? []).map((user) => user.userId).join("\n");
    }
  }

  async function saveRuntimeList(kind) {
    const isInvisible = kind === "invisible";
    if (isInvisible) {
      invisibleLoading = true;
      invisibleSaved = false;
    } else {
      blockedLoading = true;
      blockedSaved = false;
    }

    try {
      const userIds = parseLines(isInvisible ? invisibleText : blockedText);
      const result = await api(`/${kind}`, { method: "PUT", body: { userIds } });
      if (!result.ok) throw new Error(result.error ?? "unknown");
      if (isInvisible) invisibleSaved = true;
      else blockedSaved = true;
      setTimeout(() => {
        if (isInvisible) invisibleSaved = false;
        else blockedSaved = false;
      }, 2000);
      await loadRuntimeLists();
    } catch (error) {
      alert("保存失败: " + error.message);
    } finally {
      if (isInvisible) invisibleLoading = false;
      else blockedLoading = false;
    }
  }

  onMount(loadRuntimeLists);
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-shield-halved opacity-50 mr-1"></i> 访问控制
</h3>
<p class="text-xs opacity-50 mb-3">
  所有平台的入站消息在同一入口执行 filter；被拦截的消息仍会落盘并显示在消息流，但不会进入 pipeline 或 LLM，可在消息流中手动放行会话。
</p>

<div class="divider text-xs opacity-50 my-3">全平台入站 Filter</div>
<div class="cfg-grid-3">
  <label class="cfg-check">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.chatFilter.enabled}
    />
    <span>启用 Filter</span>
  </label>
  <label class="cfg-field">
    <span class="cfg-label">模式</span>
    <select class="select select-xs select-bordered w-full" bind:value={config.chatFilter.mode}>
      <option value="whitelist">白名单（仅放行命中项）</option>
      <option value="blacklist">黑名单（拒绝命中项）</option>
    </select>
  </label>
  <label class="cfg-field">
    <span class="cfg-label">条目数</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      value={(config.chatFilter.chatIds?.length ?? 0) + (config.chatFilter.userIds?.length ?? 0) + (config.chatFilter.allowedChatIds?.length ?? 0)}
      disabled
    />
  </label>
</div>

<p class="text-xs opacity-50 mt-3 mb-2">
  支持 composite ID、raw ID 和 <code>*</code> 通配符，例如 <code>telegram:-100123</code>、<code>onebot:group:456</code>、<code>discord:*</code>。会话或发送者任一命中即视为命中。
</p>
<div class="cfg-grid-2">
  <div class="cfg-field">
    <span class="cfg-label">会话 Filter（每行一个）</span>
    <MonacoEditor
      language="plaintext"
      height={180}
      value={config.chatFilter.chatIds.join("\n")}
      on:change={(event) => (config.chatFilter.chatIds = parseLines(event.detail.value))}
    />
  </div>
  <div class="cfg-field">
    <span class="cfg-label">发送者 Filter（每行一个）</span>
    <MonacoEditor
      language="plaintext"
      height={180}
      value={config.chatFilter.userIds.join("\n")}
      on:change={(event) => (config.chatFilter.userIds = parseLines(event.detail.value))}
    />
  </div>
</div>

{#if config.chatFilter.mode === "blacklist" && config.chatFilter.allowedChatIds.length > 0}
  <div class="cfg-field mt-3">
    <span class="cfg-label">已放行会话例外（每行一个）</span>
    <p class="text-xs opacity-50 mb-2">用于在保留通配符或发送者黑名单的同时放行指定会话；消息流中的“放行”按钮会自动维护此列表。</p>
    <MonacoEditor
      language="plaintext"
      height={100}
      value={config.chatFilter.allowedChatIds.join("\n")}
      on:change={(event) => (config.chatFilter.allowedChatIds = parseLines(event.detail.value))}
    />
  </div>
{/if}

<div class="divider text-xs opacity-50 my-3">隐身用户（全平台）</div>
<p class="text-xs opacity-50 mb-2">
  用户主动隐身名单，等同于 Telegram 用户发送 <code>/invisible</code>。使用 composite 用户 ID，例如 <code>telegram:123</code>、<code>discord:456</code>、<code>onebot:789</code>；独立保存并立即生效。
</p>
<div class="cfg-field">
  <MonacoEditor
    language="plaintext"
    height={120}
    value={invisibleText}
    on:change={(event) => (invisibleText = event.detail.value)}
  />
</div>
<div class="flex items-center gap-2 mt-2">
  <button class="btn btn-xs btn-primary" disabled={invisibleLoading} on:click={() => saveRuntimeList("invisible")}>
    {#if invisibleLoading}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-user-secret"></i>{/if}
    保存隐身列表
  </button>
  {#if invisibleSaved}<span class="text-xs text-success"><i class="fa-solid fa-check"></i> 已保存并生效</span>{/if}
</div>

<div class="divider text-xs opacity-50 my-3">紧急拉黑（全平台）</div>
<p class="text-xs opacity-50 mb-2">
  LLM 通过 <code>emergency.block</code> 添加用户；名单独立保存并立即生效，LLM 无法自行解除。
</p>
<div class="cfg-field mb-2">
  <span class="cfg-label">拉黑时发送的预设文案（随底部“保存配置”保存）</span>
  <textarea
    class="textarea textarea-bordered textarea-xs w-full"
    rows="3"
    placeholder="留空则使用内置默认文案"
    bind:value={config.emergencyBlock.message}
  ></textarea>
</div>
<div class="cfg-field">
  <span class="cfg-label">当前拉黑用户（composite 用户 ID，每行一个）</span>
  <MonacoEditor
    language="plaintext"
    height={120}
    value={blockedText}
    on:change={(event) => (blockedText = event.detail.value)}
  />
</div>
<div class="flex items-center gap-2 mt-2">
  <button class="btn btn-xs btn-primary" disabled={blockedLoading} on:click={() => saveRuntimeList("blocked")}>
    {#if blockedLoading}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-ban"></i>{/if}
    保存拉黑列表
  </button>
  {#if blockedSaved}<span class="text-xs text-success"><i class="fa-solid fa-check"></i> 已保存并生效</span>{/if}
</div>
