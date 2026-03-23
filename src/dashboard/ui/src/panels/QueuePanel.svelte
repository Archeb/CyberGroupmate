<script>
  import { appState, activeTab } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { shortId, getPlatform, platformLabel } from "../lib/utils.js";

  $: queueData = $appState.queue || { active: [], dequeued: [] };
  $: activeList = [...(queueData.active || [])].sort(
    (a, b) => b.priority - a.priority,
  );
  $: dequeuedList = [...(queueData.dequeued || [])].reverse();

  let showEnqueue = false;

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
</script>

<div class="card bg-base-100 mb-4">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2 queue-header">
      <h3 class="card-title text-sm">注意力队列 (Q3) — 活跃</h3>
      <button class="btn btn-xs btn-primary" onclick={showEnqueueModal}
        >手动入队</button
      >
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead
          ><tr>
            <th>ChatId</th><th>优先级</th><th>来源</th><th class="hide-mobile">Stickiness</th>
            <th>新消息</th><th class="hide-mobile">话题数</th><th class="hide-mobile">状态</th><th>操作</th>
          </tr></thead
        >
        <tbody>
          {#if !activeList.length}
            <tr><td colspan="8" class="text-center opacity-60">队列为空</td></tr
            >
          {:else}
            {#each activeList as e}
              <tr class="queue-row" class:is-blocked={e.blocked}>
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
                <td
                  class={e.priority > 50
                    ? "priority-high"
                    : e.priority > 20
                      ? "priority-mid"
                      : "priority-low"}>{e.priority.toFixed(1)}</td
                >
                <td><span class="badge badge-xs">{e.source}</span></td>
                <td class="stickiness-{e.stickinessLevel} hide-mobile"
                  >{e.stickinessLevel}</td
                >
                <td>{e.newMessageCount}</td>
                <td class="hide-mobile">{(e.topicDigests || []).length}</td>
                <td class="hide-mobile"
                  >{#if e.blocked}<span class="badge badge-xs badge-error"
                      >阻塞</span
                    >{:else}<span class="badge badge-xs badge-success"
                      >活跃</span
                    >{/if}</td
                >
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

<!-- Dequeued History -->
<div class="collapse collapse-arrow bg-base-100">
  <input type="checkbox" />
  <div class="collapse-title text-sm font-medium">
    <i class="fa-solid fa-clock-rotate-left opacity-50 mr-1"></i> 已处理<span
      class="badge badge-sm badge-ghost ml-2">{dequeuedList.length}</span
    >
  </div>
  <div class="collapse-content">
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead
          ><tr>
            <th>ChatId</th><th>优先级</th><th>来源</th><th class="hide-mobile">Stickiness</th><th
              >出队时间</th
            >
          </tr></thead
        >
        <tbody>
          {#if !dequeuedList.length}
            <tr><td colspan="5" class="text-center opacity-60">暂无历史</td></tr
            >
          {:else}
            {#each dequeuedList as d}
              <tr class="dequeued-row">
                <td
                  class="font-mono text-xs clickable-id"
                  onclick={() => quickQueryGroup(d.entry.chatId)}
                >
                  {#if getPlatform(d.entry.chatId)}<span
                      class="platform-badge platform-{getPlatform(
                        d.entry.chatId,
                      )}">{platformLabel(getPlatform(d.entry.chatId))}</span
                    >{/if}
                  {shortId(d.entry.chatId)}
                </td>
                <td>{d.entry.priority.toFixed(1)}</td>
                <td><span class="badge badge-xs">{d.entry.source}</span></td>
                <td class="stickiness-{d.entry.stickinessLevel} hide-mobile"
                  >{d.entry.stickinessLevel}</td
                >
                <td class="opacity-60"
                  >{new Date(d.dequeuedAt).toLocaleTimeString()}</td
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
  .queue-row.is-blocked {
    opacity: 0.5;
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

  .stickiness-CORE {
    color: var(--color-error);
  }
  .stickiness-FAMILIAR {
    color: var(--color-warning);
  }
  .stickiness-ACQUAINTANCE {
    color: var(--color-success);
  }
  .stickiness-STRANGER {
    color: color-mix(in srgb, var(--color-base-content) 60%, transparent);
  }

  .dequeued-row :global(td) {
    opacity: 0.7;
  }

  @media (max-width: 768px) {
    .queue-header { flex-wrap: wrap; gap: 0.5rem; }
  }
</style>
