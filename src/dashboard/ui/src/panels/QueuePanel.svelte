<script>
  import { appState, activeTab } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { shortId, getPlatform, platformLabel } from "../lib/utils.js";

  $: queueData = $appState.queue || { active: [], dequeued: [], blockedChatIds: [] };
  $: activeList = [...(queueData.active || [])].sort(
    (a, b) => (a.layer ?? 99) - (b.layer ?? 99)
      || (b.pressure ?? 0) - (a.pressure ?? 0)
      || (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0),
  );
  $: dequeuedList = [...(queueData.dequeued || [])].reverse();
  $: blockedChatIds = queueData.blockedChatIds || [];

  async function boost(chatId) {
    await api("/queue/boost", { method: "POST", body: { chatId, amount: 20 } });
  }

  async function remove(chatId) {
    await api(`/queue/${chatId}`, { method: "DELETE" });
  }

  function quickQueryGroup(chatId) {
    activeTab.set("memory");
    window.dispatchEvent(
      new CustomEvent("quickQueryGroup", { detail: { chatId } }),
    );
  }

  function showEnqueueModal() {
    window.dispatchEvent(new CustomEvent("showEnqueueModal"));
  }

  function layerLabel(layer) {
    return layer === 0 ? "L0" : layer === 1 ? "L1" : "L2";
  }

  function layerClass(layer) {
    return layer === 0 ? "badge-error" : layer === 1 ? "badge-warning" : "badge-info";
  }

  function kindLabel(kind) {
    return kind === "signal" ? "signal" : "pending";
  }

  function historyKind(item) {
    return item?.layer === 2 ? "signal" : "pending";
  }

  function summarizePayload(item) {
    const payload = item?.payload;
    if (!payload || typeof payload !== "object") return "-";
    if (typeof payload.reason === "string") return payload.reason;
    if (typeof payload.description === "string") return payload.description;
    if (typeof payload.type === "string") return payload.type;
    if (Array.isArray(payload.topicDigests)) return `${payload.topicDigests.length} topics`;
    return "-";
  }
</script>

<div class="card bg-base-100 mb-4">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2 queue-header">
      <h3 class="card-title text-sm">AttentionAccumulator - 活跃</h3>
      <button class="btn btn-xs btn-primary" onclick={showEnqueueModal}
        >手动注入</button
      >
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead
          ><tr>
            <th>ChatId</th><th>Layer</th><th>Pressure</th><th>来源</th><th class="hide-mobile">Kind</th>
            <th class="hide-mobile">摘要</th><th>操作</th>
          </tr></thead
        >
        <tbody>
          {#if !activeList.length}
            <tr><td colspan="7" class="text-center opacity-60">队列为空</td></tr
            >
          {:else}
            {#each activeList as e}
              <tr class="queue-row">
                <td
                  class="font-mono text-xs clickable-id"
                  onclick={() => quickQueryGroup(e.chatId)}
                >
                  {#if getPlatform(e.chatId)}<span
                      class="platform-badge platform-{getPlatform(e.chatId)}"
                      >{platformLabel(getPlatform(e.chatId))}</span
                    >{/if}
                  {shortId(e.chatId)}
                </td>
                <td><span class={`badge badge-xs ${layerClass(e.layer)}`}>{layerLabel(e.layer)}</span></td>
                <td
                  class={(e.pressure ?? 0) > 50
                    ? "priority-high"
                    : (e.pressure ?? 0) > 20
                      ? "priority-mid"
                      : "priority-low"}>{typeof e.pressure === "number" ? e.pressure.toFixed(1) : "-"}</td
                >
                <td><span class="badge badge-xs">{e.source}</span></td>
                <td class="hide-mobile"><span class="badge badge-xs badge-ghost">{kindLabel(e.kind)}</span></td>
                <td class="hide-mobile">{summarizePayload(e)}</td>
                <td>
                  <div class="flex gap-1">
                    <button
                      class="btn btn-xs btn-ghost"
                      onclick={() => boost(e.chatId)}>⬆</button
                    >
                    <button
                      class="btn btn-xs btn-ghost text-error"
                      onclick={() => remove(e.chatId)}>✕</button
                    >
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="card bg-base-100 mb-4">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">Blocked Chats</h3>
      <span class="badge badge-sm badge-ghost">{blockedChatIds.length}</span>
    </div>
    {#if !blockedChatIds.length}
      <div class="opacity-60 text-sm">暂无阻塞 chatId</div>
    {:else}
      <div class="flex flex-wrap gap-2">
        {#each blockedChatIds as chatId}
          <button class="badge badge-outline h-auto py-2 px-3 font-mono text-xs" onclick={() => quickQueryGroup(chatId)}>{shortId(chatId)}</button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<div class="collapse collapse-arrow bg-base-100">
  <input type="checkbox" />
  <div class="collapse-title text-sm font-medium">
    <i class="fa-solid fa-clock-rotate-left opacity-50 mr-1"></i> 已释放<span
      class="badge badge-sm badge-ghost ml-2">{dequeuedList.length}</span
    >
  </div>
  <div class="collapse-content">
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead
          ><tr>
            <th>ChatId</th><th>Layer</th><th>Pressure</th><th>来源</th><th class="hide-mobile">Kind</th><th
              >释放时间</th
            >
          </tr></thead
        >
        <tbody>
          {#if !dequeuedList.length}
            <tr><td colspan="6" class="text-center opacity-60">暂无历史</td></tr
            >
          {:else}
            {#each dequeuedList as d}
              <tr class="dequeued-row">
                <td
                  class="font-mono text-xs clickable-id"
                  onclick={() => quickQueryGroup(d.item.chatId)}
                >
                  {#if getPlatform(d.item.chatId)}<span
                      class="platform-badge platform-{getPlatform(
                        d.item.chatId,
                      )}">{platformLabel(getPlatform(d.item.chatId))}</span
                    >{/if}
                  {shortId(d.item.chatId)}
                </td>
                <td><span class={`badge badge-xs ${layerClass(d.item.layer)}`}>{layerLabel(d.item.layer)}</span></td>
                <td>{typeof d.item.pressure === "number" ? d.item.pressure.toFixed(1) : "-"}</td>
                <td><span class="badge badge-xs">{d.item.source}</span></td>
                <td class="hide-mobile"><span class="badge badge-xs badge-ghost">{kindLabel(historyKind(d.item))}</span></td>
                <td class="opacity-60"
                  >{new Date(d.releasedAt).toLocaleTimeString()}</td
                >
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>
</div>

<style>
  .queue-row :global(td) {
    vertical-align: middle;
  }

  .priority-high {
    color: var(--color-error);
    font-weight: 700;
  }
  .priority-mid {
    color: var(--color-warning);
    font-weight: 600;
  }
  .priority-low {
    color: var(--color-success);
  }

  .dequeued-row :global(td) {
    opacity: 0.7;
  }

  @media (max-width: 768px) {
    .queue-header { flex-wrap: wrap; gap: 0.5rem; }
  }
</style>
