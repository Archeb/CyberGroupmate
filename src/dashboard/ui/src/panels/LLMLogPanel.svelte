<script>
  import {
    llmLogs,
    llmStats,
    selectedLLMCallId,
    clearLLMLogs,
    calculateCallCost,
  } from "../lib/stores.js";
  import { escapeHtml } from "../lib/utils.js";

  function formatCost(cost) {
    if (cost === 0) return '';
    if (cost < 0.001) return `$${cost.toFixed(6)}`;
    if (cost < 0.01) return `$${cost.toFixed(5)}`;
    return `$${cost.toFixed(4)}`;
  }

  const CALLER_COLORS = {
    "attend-handler": "badge-primary",
    "fast-path": "badge-warning",
    "session-runner": "badge-accent",
    "context-manager": "badge-info",
    reflection: "badge-secondary",
    memory: "badge-success",
    vision: "badge-error",
    "recording-pipeline": "badge-ghost",
  };

  let expandedMsgs = {};
  let expandedResp = {};

  function selectLog(callId) {
    selectedLLMCallId.set(callId);
  }

  $: selectedEntry = $selectedLLMCallId
    ? $llmLogs.find((e) => e.callId === $selectedLLMCallId)
    : null;

  function toggleMsg(callId, idx) {
    const key = `${callId}-${idx}`;
    expandedMsgs[key] = !expandedMsgs[key];
    expandedMsgs = expandedMsgs;
  }

  function toggleResp(callId) {
    expandedResp[callId] = !expandedResp[callId];
    expandedResp = expandedResp;
  }
</script>

<div class="llm-log-layout">
  <!-- Left: log list -->
  <div class="llm-log-left">
    <div class="llm-log-toolbar">
      <span class="text-xs opacity-60">调用 <b>{$llmStats.total}</b></span>
      <span class="text-xs text-success">✓ <b>{$llmStats.success}</b></span>
      <span class="text-xs text-error">✗ <b>{$llmStats.error}</b></span>
      <span class="text-xs opacity-60"
        >Tok <b>{$llmStats.totalTokens.toLocaleString()}</b></span
      >
      {#if $llmStats.totalCost > 0}
        <span class="text-xs text-warning"
          >💰 <b>{formatCost($llmStats.totalCost)}</b></span
        >
      {/if}
      <button
        class="btn btn-xs btn-ghost"
        onclick={() => {
          clearLLMLogs();
          expandedMsgs = {};
          expandedResp = {};
        }}>清空</button
      >
    </div>
    <div class="llm-log-list">
      {#if !$llmLogs.length}
        <div class="text-sm opacity-40 p-4">等待 LLM 调用...</div>
      {:else}
        {#each $llmLogs as entry}
          {@const r = entry.response}
          {@const callerBadge = CALLER_COLORS[entry.caller] || "badge-ghost"}
          {@const time = new Date(entry.timestamp).toLocaleTimeString()}
          {@const msgCount = entry.messageSummaries?.length ?? 0}
          {@const hasImages = entry.messageSummaries?.some(
            (m) => m.imageCount > 0,
          )}
          <button
            type="button"
            class="llm-log-row"
            class:llm-log-active={$selectedLLMCallId === entry.callId}
            class:llm-log-error={r?.error}
            onclick={() => selectLog(entry.callId)}
          >
            <span
              class="llm-row-status"
              data-status={r ? (r.error ? "error" : "ok") : "pending"}
            >
              {r ? (r.error ? "✗" : "✓") : "⠇"}
            </span>
            <span class="llm-row-time">{time}</span>
            <span class="badge badge-xs {callerBadge}">{entry.caller}</span>
            <span class="llm-row-model">{entry.model}</span>
            <span class="llm-row-meta"
              >✉{msgCount}{hasImages ? " 🖼" : ""}</span
            >
            <span class="llm-row-duration">
              {#if r}{r.durationMs}ms{r.usage?.totalTokens
                  ? ` (${r.usage.totalTokens}tok)`
                  : ""}{@const cost = calculateCallCost(r.usage, entry.model)}{cost > 0 ? ` ${formatCost(cost)}` : ""}{:else}...{/if}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- Right: detail -->
  <div class="llm-log-right">
    <div class="llm-log-detail-pane">
      {#if !selectedEntry}
        <div class="text-sm opacity-40 p-4">← 点击左侧条目查看详情</div>
      {:else}
        {@const r = selectedEntry.response}
        {@const callerBadge =
          CALLER_COLORS[selectedEntry.caller] || "badge-ghost"}
        <!-- Header -->
        <div class="llm-detail-header">
          <span class="badge badge-sm {callerBadge}"
            >{selectedEntry.caller}</span
          >
          <span class="opacity-70">{selectedEntry.model}</span>
          <span class="opacity-40"
            >T={selectedEntry.temperature} max={selectedEntry.maxTokens}</span
          >
          {#if r}
            <span class="opacity-60">{r.durationMs}ms</span>
            {#if r.usage}
              <span class="opacity-40">
                prompt:{r.usage.promptTokens ?? "?"}
                {#if r.usage.cachedTokens}(cached:{r.usage.cachedTokens}){/if}
                {#if r.usage.cacheCreationTokens}(创建:{r.usage.cacheCreationTokens}){/if}
                / completion:{r.usage.completionTokens ?? "?"}
                / total:{r.usage.totalTokens ?? "?"}
              </span>
              {@const detailCost = calculateCallCost(r.usage, selectedEntry.model)}
              {#if detailCost > 0}
                <span class="text-warning">{formatCost(detailCost)}</span>
              {/if}
            {/if}
          {:else}
            <span class="text-warning">进行中...</span>
          {/if}
        </div>

        <!-- Messages -->
        <div class="llm-detail-section">
          <div class="llm-detail-section-title">
            Messages ({selectedEntry.messageSummaries?.length ?? 0})
          </div>
          {#each selectedEntry.messageSummaries || [] as m, mi}
            {@const roleClass =
              m.role === "system"
                ? "llm-role-system"
                : m.role === "assistant"
                  ? "llm-role-assistant"
                  : "llm-role-user"}
            {@const content = m.contentPreview || ""}
            {@const isExpanded = expandedMsgs[`${selectedEntry.callId}-${mi}`]}
            {@const displayContent = isExpanded
              ? content
              : content.length > 200
                ? content.slice(0, 200) + "..."
                : content}
            <div class="llm-detail-msg">
              <div class="llm-detail-msg-role {roleClass}">{m.role}</div>
              <div class="llm-detail-msg-content">{displayContent}</div>
              {#if content.length > 200}
                <button
                  class="llm-msg-toggle"
                  onclick={() => toggleMsg(selectedEntry.callId, mi)}
                >
                  {isExpanded ? "收起" : "展开"}
                </button>
              {/if}
              {#if m.imageCount > 0}
                <div class="llm-detail-msg-images">
                  {#each m.imageUrls || [] as url}
                    {@const isData = url.startsWith("data:")}
                    {@const label = isData
                      ? url.split(";")[0].replace("data:", "")
                      : "URL"}
                    <span class="llm-img-hover-wrap">
                      <span class="badge badge-sm badge-outline"
                        >🖼️ {label}</span
                      >
                      <img
                        class="llm-img-preview"
                        src={url}
                        alt="preview"
                        loading="lazy"
                      />
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Response -->
        {#if r}
          <div class="llm-detail-section">
            <div class="llm-detail-section-title">
              Response ({r.contentLength ?? 0} chars)
            </div>
            {#if r.error}
              <div class="llm-detail-error">{r.error}</div>
            {:else}
              {@const respContent = r.contentPreview || "(empty)"}
              {@const respExpanded = expandedResp[selectedEntry.callId]}
              {@const displayResp = respExpanded
                ? respContent
                : respContent.length > 500
                  ? respContent.slice(0, 500) + "..."
                  : respContent}
              <div class="llm-detail-response-body">{displayResp}</div>
              {#if respContent.length > 500}
                <button
                  class="llm-msg-toggle"
                  onclick={() => toggleResp(selectedEntry.callId)}
                >
                  {respExpanded ? "收起" : "展开"}
                </button>
              {/if}
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .llm-log-layout {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 0;
    height: calc(100vh - 180px);
    background: var(--color-base-100);
    border-radius: var(--radius-box, 0.5rem);
    overflow: hidden;
  }

  .llm-log-left {
    display: flex;
    flex-direction: column;
    border-right: 1px solid
      color-mix(in srgb, var(--color-base-content) 10%, transparent);
    min-height: 0;
  }

  .llm-log-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid
      color-mix(in srgb, var(--color-base-content) 8%, transparent);
    flex-shrink: 0;
  }

  .llm-log-list {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .llm-log-right {
    min-height: 0;
    overflow: hidden;
  }

  .llm-log-detail-pane {
    height: 100%;
    overflow-y: auto;
    padding: 0 0.75rem;
    font-size: 0.8rem;
  }

  .llm-log-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.75rem;
    cursor: pointer;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    flex-wrap: nowrap;
    border: none;
    border-bottom: 1px solid
      color-mix(in srgb, var(--color-base-content) 5%, transparent);
    transition: background 0.1s;
    background: transparent;
    color: inherit;
    text-align: left;
    width: 100%;
  }

  .llm-log-row:hover {
    background: color-mix(in srgb, var(--color-base-content) 6%, transparent);
  }

  .llm-log-row.llm-log-active {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    border-left: 3px solid var(--color-primary);
    padding-left: calc(0.75rem - 3px);
  }

  .llm-log-row.llm-log-error {
    color: var(--color-error);
  }

  .llm-row-status {
    flex-shrink: 0;
    width: 1.2em;
    text-align: center;
  }
  .llm-row-status[data-status="pending"] {
    color: var(--color-warning);
  }
  .llm-row-status[data-status="ok"] {
    color: var(--color-success);
  }
  .llm-row-status[data-status="error"] {
    color: var(--color-error);
  }

  .llm-row-time {
    color: var(--color-secondary);
    flex-shrink: 0;
    font-size: 0.65rem;
  }

  .llm-row-model {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  .llm-row-meta {
    opacity: 0.4;
    flex-shrink: 0;
  }
  .llm-row-duration {
    opacity: 0.5;
    margin-left: auto;
    flex-shrink: 0;
  }

  .llm-detail-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding-bottom: 0.75rem;
    margin-bottom: 0.75rem;
    border-bottom: 1px solid
      color-mix(in srgb, var(--color-base-content) 10%, transparent);
    font-size: 0.75rem;
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--color-base-100);
    padding-top: 0.75rem;
  }

  .llm-detail-section {
    margin-bottom: 1rem;
  }

  .llm-detail-section-title {
    font-weight: 700;
    font-size: 0.75rem;
    margin-bottom: 0.5rem;
    opacity: 0.6;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .llm-detail-msg {
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.25rem;
    background: color-mix(in srgb, var(--color-base-content) 4%, transparent);
    border-radius: 0.375rem;
    border-left: 3px solid transparent;
  }

  .llm-detail-msg-role {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    margin-bottom: 0.2rem;
  }

  .llm-role-system {
    color: var(--color-info);
  }
  .llm-detail-msg:has(.llm-role-system) {
    border-left-color: var(--color-info);
  }

  .llm-role-assistant {
    color: var(--color-primary);
  }
  .llm-detail-msg:has(.llm-role-assistant) {
    border-left-color: var(--color-primary);
  }

  .llm-role-user {
    color: var(--color-success);
  }
  .llm-detail-msg:has(.llm-role-user) {
    border-left-color: var(--color-success);
  }

  .llm-detail-msg-content {
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.85;
    font-size: 0.78rem;
    line-height: 1.5;
  }

  .llm-detail-msg-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.4rem;
  }

  .llm-msg-toggle {
    display: inline-block;
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: var(--color-primary);
    cursor: pointer;
    opacity: 0.8;
  }

  .llm-msg-toggle:hover {
    opacity: 1;
    text-decoration: underline;
  }

  .llm-img-hover-wrap {
    position: relative;
    display: inline-block;
    cursor: pointer;
  }

  .llm-img-preview {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    max-width: 320px;
    max-height: 240px;
    object-fit: contain;
    border-radius: 0.375rem;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    border: 1px solid
      color-mix(in srgb, var(--color-base-content) 15%, transparent);
    z-index: 50;
    background: var(--color-base-200);
  }

  .llm-img-hover-wrap:hover .llm-img-preview {
    display: block;
  }

  .llm-detail-error {
    color: var(--color-error);
    padding: 0.5rem;
    background: color-mix(in srgb, var(--color-error) 8%, transparent);
    border-radius: 0.375rem;
  }

  .llm-detail-response-body {
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.85;
    font-size: 0.78rem;
    line-height: 1.5;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--color-base-content) 4%, transparent);
    border-radius: 0.375rem;
    border-left: 3px solid var(--color-secondary);
  }
</style>
