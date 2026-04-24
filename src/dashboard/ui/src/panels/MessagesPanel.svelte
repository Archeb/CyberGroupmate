<script>
  import { onMount, tick } from "svelte";
  import {
    messages,
    selectedChatId,
    appState,
    activeTab,
  } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import {
    escapeHtml,
    shortId,
    getGroupLabel,
    getChatTypeLabel,
    isAtBottom,
    scrollToBottom,
    getPlatform,
    platformLabel,
  } from "../lib/utils.js";

  let flushing = false;
  let reflecting = false;

  // ─── Mute 状态 ───
  let mutedChatIds = new Set();
  let muteRemaining = {};  // chatId → remaining string
  let globalMuteLoading = false;
  let chatMuteLoading = false;

  async function fetchMuteStatus() {
    try {
      const res = await api("/mute/status");
      const newSet = new Set();
      const newRemaining = {};
      for (const m of (res.muted ?? [])) {
        newSet.add(m.chatId);
        newRemaining[m.chatId] = m.remaining;
      }
      mutedChatIds = newSet;
      muteRemaining = newRemaining;
    } catch { /* ignore */ }
  }

  $: isCurrentChatMuted = $selectedChatId ? mutedChatIds.has($selectedChatId) : false;
  $: anyMuted = mutedChatIds.size > 0;
  // 全局禁言 = 所有已知群都被 mute
  $: isGlobalMuted = allChatIds.length > 0 && allChatIds.every(id => mutedChatIds.has(id));
  // 当前群是因为全局禁言而被 mute（不是单独 mute 的）
  $: isCurrentMutedByGlobal = isCurrentChatMuted && isGlobalMuted;

  async function toggleGlobalMute() {
    globalMuteLoading = true;
    try {
      if (anyMuted) {
        await api("/mute/clear", { method: "POST" });
      } else {
        await api("/mute/all", { method: "POST", body: { hours: 1 } });
      }
      await fetchMuteStatus();
    } catch (e) {
      alert("操作失败: " + e.message);
    } finally {
      globalMuteLoading = false;
    }
  }

  async function toggleChatMute() {
    if (!$selectedChatId) return;
    chatMuteLoading = true;
    try {
      if (isCurrentChatMuted) {
        await api(`/mute/chat/${encodeURIComponent($selectedChatId)}/unmute`, { method: "POST" });
      } else {
        await api(`/mute/chat/${encodeURIComponent($selectedChatId)}`, { method: "POST", body: { hours: 1 } });
      }
      await fetchMuteStatus();
    } catch (e) {
      alert("操作失败: " + e.message);
    } finally {
      chatMuteLoading = false;
    }
  }

  onMount(() => {
    fetchMuteStatus();
    const interval = setInterval(fetchMuteStatus, 15000);
    return () => clearInterval(interval);
  });

  async function triggerFlush() {
    if (!$selectedChatId || flushing) return;
    flushing = true;
    try {
      await api(`/recording/flush/${encodeURIComponent($selectedChatId)}`, {
        method: "POST",
      });
    } catch (e) {
      alert("Flush 失败: " + e.message);
    } finally {
      flushing = false;
    }
  }

  async function triggerReflection() {
    if (!$selectedChatId || reflecting) return;
    reflecting = true;
    try {
      const res = await api(
        `/reflection/${encodeURIComponent($selectedChatId)}`,
        { method: "POST" },
      );
      alert(
        `Reflection 完成\n画像更新: ${res.personUpdates?.length ?? 0}\n新事实: ${res.newCoreFacts?.length ?? 0}`,
      );
    } catch (e) {
      alert("Reflection 失败: " + e.message);
    } finally {
      reflecting = false;
    }
  }

  let streamEl;
  let showSidebar = false;

  $: allChatIds = [
    ...new Set([
      ...$appState.groups.map((g) => g.chatId),
      ...$messages.map((m) => m.chatId),
    ]),
  ];
  $: filtered = $selectedChatId
    ? $messages.filter((m) => m.chatId === $selectedChatId)
    : $messages;
  $: displayMessages = filtered.slice(-200);

  async function selectChat(chatId) {
    selectedChatId.set(chatId);
    showSidebar = false;
    if (chatId) {
      try {
        const history = await api(`/messages/${chatId}?limit=100`);
        if (Array.isArray(history) && history.length > 0) {
          messages.update((msgs) => {
            const existingIds = new Set(msgs.map((m) => m.messageId || m.id));
            const newMsgs = history
              .filter((m) => !existingIds.has(m.messageId))
              .map((m) => ({
                chatId: m.chatId,
                messageId: m.messageId,
                userId: m.userId,
                displayName: m.displayName,
                text: m.text,
                timestamp: m.timestamp,
              }));
            if (newMsgs.length > 0) {
              msgs.push(...newMsgs);
              msgs.sort(
                (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
              );
              if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
            }
            return msgs;
          });
        }
      } catch {
        /* ignore */
      }
    }
  }

  function quickQueryUser(userId, chatId) {
    activeTab.set("memory");
    // will be handled by MemoryPanel
    window.__quickQueryUser = { userId, chatId };
    window.dispatchEvent(
      new CustomEvent("quickQueryUser", { detail: { userId, chatId } }),
    );
  }

  function editChatTitle(chatId) {
    window.dispatchEvent(new CustomEvent('memoryEdit', { detail: { type: 'group', chatId } }));
  }

  // Auto-scroll on new messages
  let wasBottom = true;
  $: if (displayMessages && streamEl) {
    wasBottom = isAtBottom(streamEl);
    tick().then(() => {
      if (wasBottom) scrollToBottom(streamEl);
    });
  }
</script>

<div class="msg-panel-layout">
  <!-- Mobile sidebar toggle -->
  <button
    class="mobile-sidebar-toggle msg-mobile-toggle"
    onclick={() => (showSidebar = true)}
  >
    ☰ 群组
  </button>

  <!-- Sidebar overlay -->
  {#if showSidebar}
    <button
      class="mobile-sidebar-overlay msg-sidebar-overlay"
      aria-label="关闭侧栏"
      onclick={() => (showSidebar = false)}
    ></button>
  {/if}

  <!-- Chat list -->
  <div class="msg-sidebar" class:msg-sidebar-open={showSidebar}>
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0">
        <h3 class="card-title text-sm">群组列表</h3>
        <div class="space-y-1 overflow-y-auto flex-1 min-h-0">
          <button
            class="chat-item"
            class:active={!$selectedChatId}
            onclick={() => selectChat(null)}>全部</button
          >
          {#each allChatIds as chatId}
            {@const count = $messages.filter((m) => m.chatId === chatId).length}
            {@const plat = getPlatform(chatId)}
            {@const chatType = getChatTypeLabel(chatId)}
            <button
              class="chat-item"
              class:active={$selectedChatId === chatId}
              onclick={() => selectChat(chatId)}
              title={chatId}
            >
              <span class="flex items-center gap-1">
                {#if plat}<span class="platform-badge platform-{plat}"
                    >{platformLabel(plat)}</span
                  >{/if}
                {#if chatType}<span class="chat-type-badge">{chatType}</span>{/if}
                {getGroupLabel(chatId)}
              </span>
              <span class="flex items-center gap-1">
                <span class="chat-edit-btn" title="编辑群名/显示名" onclick={(e) => { e.stopPropagation(); editChatTitle(chatId); }}>
                  <i class="fa-solid fa-pen" style="font-size:0.55rem"></i>
                </span>
                {#if mutedChatIds.has(chatId)}<span title="禁言中"><i class="fa-solid fa-volume-xmark" style="font-size:0.65rem;color:var(--color-warning)"></i></span>{/if}
                <span class="badge badge-sm">{count}</span>
              </span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- Message stream -->
  <div class="msg-content">
    <div class="card bg-base-100 h-full">
      <div class="card-body p-3 min-h-0 flex flex-col">
        <div class="flex justify-between items-center shrink-0 mb-1">
          <h3 class="card-title text-sm">
            消息流
            {#if $selectedChatId}
              {#if getPlatform($selectedChatId)}<span
                  class="platform-badge platform-{getPlatform($selectedChatId)}"
                  >{platformLabel(getPlatform($selectedChatId))}</span
                >{/if}
              <span class="text-xs opacity-60"
                >{getGroupLabel($selectedChatId)}</span
              >
            {:else}
              <span class="text-xs opacity-60">全部</span>
            {/if}
          </h3>
          {#if $selectedChatId}
            <div class="flex gap-1">
              <button
                class="btn btn-xs {isCurrentChatMuted ? 'btn-warning' : 'btn-ghost'}"
                title={isCurrentMutedByGlobal ? '全局禁言中，请先在「全部」视图解除全局禁言' : isCurrentChatMuted ? `已禁言（剩余 ${muteRemaining[$selectedChatId] ?? '?'}），点击解除` : '禁言 1 小时（Bot 不发消息）'}
                disabled={chatMuteLoading || isCurrentMutedByGlobal}
                onclick={toggleChatMute}
              >
                {#if chatMuteLoading}<span class="loading loading-spinner loading-xs"
                  ></span>{:else}<i class="fa-solid {isCurrentChatMuted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>{/if}
                {isCurrentChatMuted ? 'Muted' : 'Mute'}
              </button>
              <button
                class="btn btn-xs btn-ghost"
                title="手动入队（触发 Agent 处理此群）"
                onclick={() =>
                  window.dispatchEvent(
                    new CustomEvent("showEnqueueModal", {
                      detail: { chatId: $selectedChatId },
                    }),
                  )}
              >
                <i class="fa-solid fa-paper-plane"></i>
                Enqueue
              </button>
              <button
                class="btn btn-xs btn-ghost"
                title="触发 Recording Pipeline Flush（话题聚类）"
                disabled={flushing}
                onclick={triggerFlush}
              >
                {#if flushing}<span class="loading loading-spinner loading-xs"
                  ></span>{:else}<i class="fa-solid fa-rotate"></i>{/if}
                Flush
              </button>
              <button
                class="btn btn-xs btn-ghost"
                title="触发 Reflection（画像/亲和度/事实更新）"
                disabled={reflecting}
                onclick={triggerReflection}
              >
                {#if reflecting}<span class="loading loading-spinner loading-xs"
                  ></span>{:else}<i class="fa-solid fa-brain"></i>{/if}
                Reflect
              </button>
            </div>
          {:else}
            <div class="flex gap-1">
              <button
                class="btn btn-xs {anyMuted ? 'btn-warning' : 'btn-ghost'}"
                title={anyMuted ? '解除所有群禁言' : '全局禁言 1 小时（所有群 Bot 不发消息）'}
                disabled={globalMuteLoading}
                onclick={toggleGlobalMute}
              >
                {#if globalMuteLoading}<span class="loading loading-spinner loading-xs"
                  ></span>{:else}<i class="fa-solid {anyMuted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>{/if}
                {anyMuted ? 'Muted' : 'Mute All'}
              </button>
            </div>
          {/if}
        </div>
        <div
          bind:this={streamEl}
          class="overflow-y-auto flex-1 min-h-0 space-y-1 font-mono text-sm"
        >
          {#each displayMessages as m}
            {@const time = new Date(m.timestamp).toLocaleTimeString()}
            {@const isAgent = m.userId === "agent" || m.userId === "self"}
            {@const isMention = m.mentionsAgent || m.isDirectMessage}
            <div
              class="msg-item"
              class:is-agent={isAgent}
              class:is-mention={isMention}
            >
              <span class="msg-time">{time}</span>
              {#if !$selectedChatId}
                <span class="msg-group-tag" title={m.chatId}>
                  {#if getPlatform(m.chatId)}<span
                      class="platform-badge platform-{getPlatform(m.chatId)}"
                      style="font-size:0.5rem"
                      >{platformLabel(getPlatform(m.chatId))}</span
                    >{/if}
                  {getGroupLabel(m.chatId)}
                </span>
              {/if}
              {#if isAgent}
                <span class="msg-user">🤖 Agent</span>
              {:else}
                <button
                  class="msg-user clickable-link"
                  onclick={() => quickQueryUser(m.userId, m.chatId)}
                >
                  {m.displayName || m.userId}
                </button>
              {/if}
              <span class="msg-text">{(m.text || "").slice(0, 500)}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .msg-panel-layout {
    display: flex;
    gap: 1rem;
    height: calc(100vh - 280px);
    overflow: hidden;
  }

  .msg-mobile-toggle {
    display: none;
  }
  .msg-sidebar-overlay {
    display: none;
  }

  .msg-sidebar {
    width: 16rem;
    flex-shrink: 0;
    min-height: 0;
  }

  .msg-content {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .msg-time {
    color: var(--color-secondary);
    font-size: 0.7rem;
    min-width: 4rem;
    background: color-mix(in srgb, var(--color-secondary) 10%, transparent);
    padding: 0.1rem 0.3rem;
    border-radius: 0.2rem;
    flex-shrink: 0;
  }

  .msg-user {
    color: var(--color-primary);
    font-weight: 600;
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    padding: 0.1rem 0.3rem;
    border-radius: 0.2rem;
    text-decoration: none !important;
    flex-shrink: 0;
  }

  .msg-text {
    word-break: break-word;
  }

  .msg-item {
    display: flex;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    transition: background 0.15s;
    align-items: baseline;
  }

  .msg-item:hover {
    background: var(--color-base-200);
  }
  .msg-item.is-agent {
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  }
  .msg-item.is-mention {
    border-left: 2px solid var(--color-warning);
  }

  .msg-group-tag {
    font-size: 0.65rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.2rem;
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
    color: var(--color-accent);
    white-space: nowrap;
    width: 7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 0;
    text-align: center;
    display: inline-block;
  }


  .chat-type-badge {
    font-size: 0.6rem;
    padding: 0.05rem 0.3rem;
    border-radius: 0.15rem;
    background: color-mix(in srgb, var(--color-secondary) 15%, transparent);
    color: var(--color-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .chat-edit-btn {
    opacity: 0;
    cursor: pointer;
    padding: 0.15rem 0.25rem;
    border-radius: 0.15rem;
    transition: opacity 0.15s, background 0.15s;
  }
  .chat-item:hover .chat-edit-btn {
    opacity: 0.5;
  }
  .chat-edit-btn:hover {
    opacity: 1 !important;
    background: var(--color-base-200);
  }

  .chat-item {
    padding: 0.35rem 0.5rem;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.8rem;
    transition: background 0.15s;
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
  }

  .chat-item:hover {
    background: var(--color-base-200);
  }
  .chat-item.active {
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
  }

  @media (max-width: 768px) {
    .msg-panel-layout {
      flex-direction: column;
      height: calc(100vh - 200px);
    }
    .msg-mobile-toggle {
      display: flex !important;
    }
    .msg-sidebar {
      display: none;
      width: 100%;
    }
    .msg-sidebar.msg-sidebar-open {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: 75vw;
      max-width: 300px;
      z-index: 100;
      background: var(--color-base-100);
      box-shadow: 4px 0 20px rgba(0, 0, 0, 0.3);
      padding: 0.5rem;
      overflow-y: auto;
      animation: slideInLeft 0.2s ease-out;
    }
    .msg-sidebar-overlay {
      display: none;
    }
    .msg-sidebar.msg-sidebar-open ~ .msg-content .msg-sidebar-overlay,
    :global(.msg-sidebar-open) ~ :global(.msg-sidebar-overlay) {
      display: block;
    }
    .msg-content {
      flex: 1;
      min-height: 0;
    }
    .msg-group-tag {
      width: 4rem;
      font-size: 0.55rem;
    }
    .msg-item {
      gap: 0.25rem;
      padding: 0.2rem 0.3rem;
    }
    .msg-time {
      min-width: auto;
      font-size: 0.6rem;
    }
  }
</style>
