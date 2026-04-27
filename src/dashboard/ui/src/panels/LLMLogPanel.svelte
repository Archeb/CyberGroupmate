<script>
  import { tick } from "svelte";
  import {
    llmLogs,
    llmStats,
    selectedLLMCallId,
    clearLLMLogs,
    calculateCallCost,
    llmLogHasMore,
    llmLogLoading,
    llmLogTotal,
    loadMoreLLMLogs,
  } from "../lib/stores.js";
  import { sendCommand } from "../lib/ws.js";
  import { api, apiBase } from "../lib/api.js";

  function formatCost(cost) {
    if (cost === 0) return '';
    if (cost < 0.001) return `$${cost.toFixed(6)}`;
    if (cost < 0.01) return `$${cost.toFixed(5)}`;
    return `$${cost.toFixed(4)}`;
  }

  const CALLER_COLORS = {
    "attend-handler": "badge-primary",
    "session-runner": "badge-accent",
    "context-manager": "badge-info",
    reflection: "badge-secondary",
    memory: "badge-success",
    vision: "badge-error",
    "recording-pipeline": "badge-ghost",
  };

  let expandedMsgs = {};
  let expandedResp = {};
  let autoExpand = false;
  let currentVisibleIdx = -1;
  let totalMsgCount = 0;
  let detailPane;
  let msgElements = [];
  let respElement;

  // ─── Export panel state ───
  let showExportPanel = false;
  let exportPreset = '1h';
  let exportCustomFrom = '';
  let exportCustomTo = '';
  let exportBusy = false;

  function getExportRange() {
    if (exportPreset === 'custom') {
      return { from: exportCustomFrom, to: exportCustomTo };
    }
    const now = new Date();
    const hours = exportPreset === '1h' ? 1 : exportPreset === '6h' ? 6 : 24;
    const from = new Date(now.getTime() - hours * 3600000).toISOString();
    return { from, to: now.toISOString() };
  }

  function exportCSV() {
    const { from, to } = getExportRange();
    if (!from || !to) return;
    const url = apiBase(`/llm-logs/export/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    window.open(url, '_blank');
  }

  function exportFull() {
    const { from, to } = getExportRange();
    if (!from || !to) return;
    const url = apiBase(`/llm-logs/export/full?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    window.open(url, '_blank');
  }

  function selectLog(callId) {
    selectedLLMCallId.set(callId);
  }

  $: selectedEntry = $selectedLLMCallId
    ? $llmLogs.find((e) => e.callId === $selectedLLMCallId)
    : null;

  // Auto-scroll to last message/response when selecting a new log entry
  let prevSelectedId = null;
  $: if (selectedEntry && selectedEntry.callId !== prevSelectedId) {
    prevSelectedId = selectedEntry.callId;
    scrollToLatest();
  }

  async function scrollToLatest() {
    await tick();
    // Try scrolling to response first, then last message
    if (respElement) {
      respElement.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (msgElements.length > 0) {
      msgElements[msgElements.length - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function toggleMsg(callId, idx) {
    const key = `${callId}-${idx}`;
    expandedMsgs[key] = !expandedMsgs[key];
    expandedMsgs = expandedMsgs;
  }

  function toggleResp(callId) {
    expandedResp[callId] = !expandedResp[callId];
    expandedResp = expandedResp;
  }

  function toggleAutoExpand() {
    autoExpand = !autoExpand;
    if (autoExpand && selectedEntry) {
      // Expand all for current entry
      (selectedEntry.messageSummaries || []).forEach((_, i) => {
        expandedMsgs[`${selectedEntry.callId}-${i}`] = true;
      });
      expandedResp[selectedEntry.callId] = true;
      expandedMsgs = expandedMsgs;
      expandedResp = expandedResp;
    }
  }

  // Navigate to prev/next message
  function navigateMsg(direction) {
    if (!msgElements.length) return;
    let target = currentVisibleIdx + direction;
    // Include response as last "element"
    const maxIdx = msgElements.length; // msgElements.length = response slot
    if (target < 0) target = 0;
    if (target > maxIdx) target = maxIdx;

    if (target < msgElements.length && msgElements[target]) {
      msgElements[target].scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (target === msgElements.length && respElement) {
      respElement.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // IntersectionObserver for scroll position tracking
  let observer;
  function setupObserver() {
    if (observer) observer.disconnect();
    if (!detailPane) return;

    observer = new IntersectionObserver(
      (entries) => {
        // Find the topmost visible entry
        let best = null;
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = parseInt(e.target.dataset.msgIdx, 10);
            if (!isNaN(idx) && (best === null || idx < best)) {
              best = idx;
            }
          }
        }
        if (best !== null) currentVisibleIdx = best;
      },
      { root: detailPane, threshold: 0.1 }
    );

    // Observe all message elements + response
    msgElements.forEach((el) => {
      if (el) observer.observe(el);
    });
    if (respElement) observer.observe(respElement);
  }

  // Re-setup observer when selected entry changes
  $: if (selectedEntry && detailPane) {
    tick().then(() => {
      totalMsgCount = msgElements.length + (respElement ? 1 : 0);
      setupObserver();
    });
  }

  // Export currently selected log entry as JSON
  function exportCurrentLog() {
    if (!selectedEntry) return;
    const data = JSON.stringify(selectedEntry, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date(selectedEntry.timestamp).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `llm-log-${selectedEntry.caller}-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function cancelAndRetry(callId) {
    sendCommand({ type: "llm:cancel", callId });
  }

  const REASON_LABELS = {
    rate_limit: "限流",
    server_error: "服务器错误",
    network_error: "网络错误",
    empty_response: "空响应",
    user_retry: "手动重试",
  };

  const MANIFEST_CACHE_BADGES = {
    static: "badge-info",
    delta: "badge-warning",
    snapshot: "badge-success",
    volatile: "badge-secondary",
  };

  const MANIFEST_HISTORY_BADGES = {
    persistent: "badge-primary",
    "delta-only": "badge-warning",
    ephemeral: "badge-accent",
    omit: "badge-ghost",
  };

  function hasContextManifest(entry) {
    return !!(entry?.contextManifest?.sections?.length);
  }

  function getManifestCacheBadge(cache) {
    return MANIFEST_CACHE_BADGES[cache] || "badge-ghost";
  }

  function getManifestHistoryBadge(history) {
    return MANIFEST_HISTORY_BADGES[history] || "badge-ghost";
  }

  function getManifestDiffState(section) {
    if (section.skipped) {
      return { label: "skipped", badge: "badge-ghost" };
    }
    if (section.cache === "delta" && section.deltaStats) {
      const added = section.deltaStats.added ?? 0;
      return added > 0
        ? { label: `+${added} delta`, badge: "badge-warning" }
        : { label: "delta 0", badge: "badge-success" };
    }
    return section.changed
      ? { label: "changed", badge: "badge-primary" }
      : { label: "unchanged", badge: "badge-ghost" };
  }

  function formatManifestPreview(text, max = 120) {
    if (!text) return "无预览";
    return text.length > max ? text.slice(0, max) + "..." : text;
  }

  function formatDeltaStats(deltaStats) {
    if (!deltaStats) return "";
    return `+${deltaStats.added}/${deltaStats.total} · =${deltaStats.unchanged}`;
  }

  function getManifestCardClass(section) {
    const classes = [`cache-${section.cache}`];
    if (section.skipped) classes.push("is-skipped");
    else if (section.changed) classes.push("is-changed");
    else classes.push("is-stable");
    if (section.history === "ephemeral") classes.push("history-ephemeral");
    return classes.join(" ");
  }
</script>

<div class="llm-log-layout">
  <!-- Left: log list -->
  <div class="llm-log-left">
    <div class="llm-log-toolbar">
      <span class="text-xs opacity-60">调用 <b>{$llmStats.total}</b></span>
      <span class="text-xs text-success"><i class="fa-solid fa-check"></i> <b>{$llmStats.success}</b></span>
      <span class="text-xs text-error"><i class="fa-solid fa-xmark"></i> <b>{$llmStats.error}</b></span>
      <span class="text-xs opacity-60"
        >Tok <b>{$llmStats.totalTokens.toLocaleString()}</b></span
      >
      {#if $llmStats.totalCachedTokens > 0}
        <span class="text-xs text-info"
          ><i class="fa-solid fa-database fa-xs"></i> <b>{$llmStats.totalCachedTokens.toLocaleString()}</b></span
        >
      {/if}
      {#if $llmStats.totalCost > 0}
        <span class="text-xs text-warning"
          ><i class="fa-solid fa-coins"></i> <b>{formatCost($llmStats.totalCost)}</b></span
        >
      {/if}

      <div class="llm-toolbar-actions">
        <button
          class="btn btn-xs btn-ghost"
          onclick={() => { showExportPanel = !showExportPanel; }}
          title="导出统计/日志"
        ><i class="fa-solid fa-file-export"></i></button>
        <button
          class="btn btn-xs btn-ghost"
          onclick={() => {
            clearLLMLogs();
            expandedMsgs = {};
            expandedResp = {};
          }}>清空</button
        >
      </div>
    </div>

    <!-- Export panel (collapsible) -->
    {#if showExportPanel}
      <div class="llm-export-panel">
        <div class="llm-export-row">
          <span class="text-xs font-bold opacity-70">时间范围</span>
          <div class="llm-export-presets">
            <button class="btn btn-xs" class:btn-primary={exportPreset === '1h'} onclick={() => exportPreset = '1h'}>1h</button>
            <button class="btn btn-xs" class:btn-primary={exportPreset === '6h'} onclick={() => exportPreset = '6h'}>6h</button>
            <button class="btn btn-xs" class:btn-primary={exportPreset === '24h'} onclick={() => exportPreset = '24h'}>24h</button>
            <button class="btn btn-xs" class:btn-primary={exportPreset === 'custom'} onclick={() => exportPreset = 'custom'}>自定义</button>
          </div>
        </div>
        {#if exportPreset === 'custom'}
          <div class="llm-export-row">
            <input type="datetime-local" class="input input-xs input-bordered llm-export-input" bind:value={exportCustomFrom} />
            <span class="text-xs opacity-40">→</span>
            <input type="datetime-local" class="input input-xs input-bordered llm-export-input" bind:value={exportCustomTo} />
          </div>
        {/if}
        <div class="llm-export-row">
          <button class="btn btn-xs btn-outline btn-info" onclick={exportCSV}>
            <i class="fa-solid fa-table"></i> 导出统计 CSV
          </button>
          <button class="btn btn-xs btn-outline btn-secondary" onclick={exportFull}>
            <i class="fa-solid fa-file-zipper"></i> 导出完整日志
          </button>
        </div>
      </div>
    {/if}

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
              {#if r}
                {#if r.error}<i class="fa-solid fa-xmark"></i>{:else}<i class="fa-solid fa-check"></i>{/if}
              {:else}
                <i class="fa-solid fa-spinner fa-pulse"></i>
              {/if}
            </span>
            <span class="llm-row-time">{time}</span>
            <span class="badge badge-xs {callerBadge}">{entry.caller}</span>
            <span class="llm-row-model">{entry.model}</span>
            <span class="llm-row-meta"
              ><i class="fa-solid fa-envelope fa-xs"></i>{msgCount}{hasImages ? " " : ""}{#if hasImages}<i class="fa-solid fa-image fa-xs"></i>{/if}</span
            >
            <span class="llm-row-duration">
              {#if r}{r.durationMs}ms{r.usage?.totalTokens
                  ? ` (${r.usage.totalTokens}tok)`
                  : ""}{@const cost = calculateCallCost(r.usage, entry.model)}{cost > 0 ? ` ${formatCost(cost)}` : ""}{:else}...{/if}
            </span>
            {#if hasContextManifest(entry)}
              <span class="llm-row-manifest" title="{entry.contextManifest.engineId} · {entry.contextManifest.sections.length} sections">
                <i class="fa-solid fa-layer-group fa-xs"></i>{entry.contextManifest.sections.length}
              </span>
            {/if}
            {#if entry.retries?.length > 0}
              <span class="llm-row-retry-badge" title="重试 {entry.retries.length} 次"><i class="fa-solid fa-rotate fa-xs"></i>{entry.retries.length}</span>
            {/if}
          </button>
        {/each}

        <!-- Load more button -->
        {#if $llmLogHasMore}
          <div class="llm-load-more">
            <button
              class="btn btn-xs btn-ghost btn-block"
              disabled={$llmLogLoading}
              onclick={loadMoreLLMLogs}
            >
              {#if $llmLogLoading}
                <i class="fa-solid fa-spinner fa-pulse"></i> 加载中...
              {:else}
                <i class="fa-solid fa-arrow-down"></i> 加载更多 ({$llmLogs.length}/{$llmLogTotal})
              {/if}
            </button>
          </div>
        {:else if $llmLogs.length > 0}
          <div class="llm-load-more">
            <span class="text-xs opacity-30">已加载全部 {$llmLogs.length} 条</span>
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <!-- Right: detail -->
  <div class="llm-log-right">
    <div class="llm-log-detail-pane" bind:this={detailPane}>
      {#if !selectedEntry}
        <div class="text-sm opacity-40 p-4">← 点击左侧条目查看详情</div>
      {:else}
        {@const r = selectedEntry.response}
        {@const callerBadge =
          CALLER_COLORS[selectedEntry.caller] || "badge-ghost"}
        <!-- Header -->
        <div class="llm-detail-header">
          <div class="llm-detail-header-top">
            <span class="badge badge-sm {callerBadge}"
              >{selectedEntry.caller}</span
            >
            <span class="opacity-70">{selectedEntry.model}</span>
            <span class="opacity-40"
              >T={selectedEntry.temperature} max={selectedEntry.maxTokens}</span
            >
            {#if selectedEntry.extraBody && Object.keys(selectedEntry.extraBody).length > 0}
              <span class="llm-extra-body-badge" title={JSON.stringify(selectedEntry.extraBody, null, 2)}>
                <i class="fa-solid fa-plus-circle fa-xs"></i> extraBody
              </span>
            {/if}
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
              <span class="text-warning">进行中...
                <button class="btn btn-xs btn-warning btn-outline llm-retry-btn" onclick={() => cancelAndRetry(selectedEntry.callId)} title="取消当前请求并立即重试">
                  <i class="fa-solid fa-rotate"></i> 立即重试
                </button>
              </span>
            {/if}
          </div>
          <div class="llm-detail-nav-bar">
            <button
              class="btn btn-xs btn-ghost"
              class:btn-active={autoExpand}
              onclick={() => toggleAutoExpand()}
              title="自动展开全部内容"
            >
              {#if autoExpand}<i class="fa-solid fa-chevron-down"></i> 收起全部{:else}<i class="fa-solid fa-chevron-up"></i> 展开全部{/if}
            </button>
            <span class="llm-nav-divider"></span>
            <button class="btn btn-xs btn-ghost" onclick={() => navigateMsg(-1)} title="上一个 message"><i class="fa-solid fa-caret-up"></i></button>
            <span class="llm-nav-pos">
              {#if totalMsgCount > 0}
                {currentVisibleIdx + 1}/{totalMsgCount}
              {/if}
            </span>
            <button class="btn btn-xs btn-ghost" onclick={() => navigateMsg(1)} title="下一个 message"><i class="fa-solid fa-caret-down"></i></button>
            <span class="llm-nav-divider"></span>
            <button class="btn btn-xs btn-ghost" onclick={() => scrollToLatest()} title="定位到最新"><i class="fa-solid fa-angles-down"></i></button>
            <span class="llm-nav-divider"></span>
            <button class="btn btn-xs btn-ghost" onclick={() => exportCurrentLog()} title="导出当前日志为 JSON"><i class="fa-solid fa-file-export"></i></button>
          </div>
        </div>

        {#if selectedEntry.contextManifest?.sections?.length}
          {@const manifest = selectedEntry.contextManifest}
          <div class="llm-detail-section">
            <div class="llm-detail-section-title">
              Context Manifest
            </div>
            <div class="llm-manifest-summary">
              <span class="badge badge-sm badge-outline">{manifest.engineId}</span>
              {#if manifest.chatId}
                <span class="llm-manifest-summary-chat">{manifest.chatId}</span>
              {/if}
              <span>{manifest.summary.activeSections}/{manifest.summary.totalSections} sections</span>
              <span>{manifest.summary.estimatedTokens} tok</span>
              <span>hist {manifest.summary.historicalChars}</span>
              <span>eph {manifest.summary.ephemeralChars}</span>
            </div>
            <div class="llm-manifest-grid">
              {#each manifest.sections as section}
                {@const diffState = getManifestDiffState(section)}
                {@const deltaLabel = formatDeltaStats(section.deltaStats)}
                <div class="llm-manifest-card {getManifestCardClass(section)}">
                  <div class="llm-manifest-card-top">
                    <div class="llm-manifest-heading">
                      <div class="llm-manifest-label">{section.label}</div>
                      <div class="llm-manifest-name">{section.name}</div>
                    </div>
                    <span class="badge badge-xs {diffState.badge}">{diffState.label}</span>
                  </div>
                  <div class="llm-manifest-source">{section.source}</div>
                  <div class="llm-manifest-badges">
                    <span class="badge badge-xs {getManifestCacheBadge(section.cache)}">{section.cache}</span>
                    <span class="badge badge-xs {getManifestHistoryBadge(section.history)}">{section.history}</span>
                    {#if deltaLabel}
                      <span class="badge badge-xs badge-outline">{deltaLabel}</span>
                    {/if}
                  </div>
                  <div class="llm-manifest-preview">{formatManifestPreview(section.contentPreview, 88)}</div>

                  <div class="llm-manifest-hover">
                    <div class="llm-manifest-hover-title">{section.label}</div>
                    <div class="llm-manifest-hover-row"><span>name</span><strong>{section.name}</strong></div>
                    <div class="llm-manifest-hover-row"><span>source</span><strong>{section.source}</strong></div>
                    <div class="llm-manifest-hover-row"><span>cache</span><strong>{section.cache}</strong></div>
                    <div class="llm-manifest-hover-row"><span>history</span><strong>{section.history}</strong></div>
                    <div class="llm-manifest-hover-row"><span>state</span><strong>{diffState.label}</strong></div>
                    <div class="llm-manifest-hover-row"><span>chars</span><strong>{section.renderedChars}</strong></div>
                    <div class="llm-manifest-hover-row"><span>tokens</span><strong>{section.estimatedTokens}</strong></div>
                    {#if section.deltaStats}
                      <div class="llm-manifest-hover-row"><span>delta</span><strong>{formatDeltaStats(section.deltaStats)}</strong></div>
                    {/if}
                    <div class="llm-manifest-hover-preview">{section.contentPreview || "无内容预览"}</div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

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
            {@const isExpanded = autoExpand || expandedMsgs[`${selectedEntry.callId}-${mi}`]}
            {@const displayContent = isExpanded
              ? content
              : content.length > 200
                ? content.slice(0, 200) + "..."
                : content}
            <div class="llm-detail-msg" bind:this={msgElements[mi]} data-msg-idx={mi}>
              <div class="llm-detail-msg-role {roleClass}">{m.role}</div>
              <div class="llm-detail-msg-content">{displayContent}</div>
              {#if content.length > 200}
                <button
                  class="llm-msg-toggle"
                  onclick={() => toggleMsg(selectedEntry.callId, mi)}
                >
                  {isExpanded && !autoExpand ? "收起" : autoExpand ? "" : "展开"}
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
                        ><i class="fa-solid fa-image"></i> {label}</span
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

        <!-- Extra Body -->
        {#if selectedEntry.extraBody && Object.keys(selectedEntry.extraBody).length > 0}
          <div class="llm-detail-section">
            <div class="llm-detail-section-title">
              Extra Body
            </div>
            <div class="llm-detail-extra-body">
              <pre class="llm-extra-body-json">{JSON.stringify(selectedEntry.extraBody, null, 2)}</pre>
            </div>
          </div>
        {/if}

        <!-- Retries -->
        {#if selectedEntry.retries?.length > 0}
          <div class="llm-detail-section">
            <div class="llm-detail-section-title">
              Retries ({selectedEntry.retries.length})
            </div>
            {#each selectedEntry.retries as retry, ri}
              <div class="llm-retry-entry">
                <span class="llm-retry-attempt">#{retry.attempt}/{retry.maxRetries}</span>
                <span class="badge badge-xs" class:badge-warning={retry.reason === 'rate_limit'} class:badge-error={retry.reason === 'server_error' || retry.reason === 'network_error'} class:badge-info={retry.reason === 'user_retry'} class:badge-ghost={!['rate_limit','server_error','network_error','user_retry'].includes(retry.reason)}>
                  {REASON_LABELS[retry.reason] || retry.reason}
                </span>
                <span class="llm-retry-delay">
                  {retry.retryDelayMs > 0 ? `${retry.retryDelayMs}ms 后重试` : '立即重试'}
                </span>
                <span class="llm-retry-error">{retry.error.slice(0, 120)}</span>
                <span class="llm-retry-time">{new Date(retry.timestamp).toLocaleTimeString()}</span>
              </div>
            {/each}
          </div>
        {/if}

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
              {@const respExpanded = autoExpand || expandedResp[selectedEntry.callId]}
              {@const displayResp = respExpanded
                ? respContent
                : respContent.length > 500
                  ? respContent.slice(0, 500) + "..."
                  : respContent}
              <div class="llm-detail-response-body" bind:this={respElement} data-msg-idx={selectedEntry.messageSummaries?.length ?? 0}>{displayResp}</div>
              {#if respContent.length > 500}
                <button
                  class="llm-msg-toggle"
                  onclick={() => toggleResp(selectedEntry.callId)}
                >
                  {respExpanded && !autoExpand ? "收起" : autoExpand ? "" : "展开"}
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
    flex-wrap: wrap;
  }

  .llm-toolbar-actions {
    margin-left: auto;
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  /* ── Export panel ── */
  .llm-export-panel {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, var(--color-base-content) 8%, transparent);
    background: color-mix(in srgb, var(--color-base-content) 3%, transparent);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .llm-export-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .llm-export-presets {
    display: flex;
    gap: 0.2rem;
  }

  .llm-export-input {
    width: 160px;
    font-size: 0.7rem;
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

  .llm-row-manifest {
    opacity: 0.55;
    flex-shrink: 0;
    font-size: 0.65rem;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .llm-detail-header {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-bottom: 0.5rem;
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

  .llm-detail-header-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .llm-detail-nav-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
  }

  .llm-nav-divider {
    width: 1px;
    height: 1em;
    background: color-mix(in srgb, var(--color-base-content) 15%, transparent);
    margin: 0 0.25rem;
  }

  .llm-nav-pos {
    font-size: 0.65rem;
    opacity: 0.6;
    font-family: ui-monospace, monospace;
    min-width: 3em;
    text-align: center;
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

  .llm-manifest-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
    margin-bottom: 0.65rem;
    font-size: 0.72rem;
    opacity: 0.72;
  }

  .llm-manifest-summary-chat {
    font-family: ui-monospace, monospace;
    opacity: 0.65;
  }

  .llm-manifest-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.5rem;
  }

  .llm-manifest-card {
    position: relative;
    padding: 0.65rem 0.7rem;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--color-base-content) 9%, transparent);
    overflow: visible;
    transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
  }

  .llm-manifest-card:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--color-base-content) 18%, transparent);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
  }

  .llm-manifest-card.cache-static {
    background: color-mix(in srgb, var(--color-info) 12%, var(--color-base-100));
  }

  .llm-manifest-card.cache-delta {
    background: color-mix(in srgb, var(--color-warning) 12%, var(--color-base-100));
  }

  .llm-manifest-card.cache-snapshot {
    background: color-mix(in srgb, var(--color-success) 11%, var(--color-base-100));
  }

  .llm-manifest-card.cache-volatile {
    background: color-mix(in srgb, var(--color-secondary) 11%, var(--color-base-100));
  }

  .llm-manifest-card.is-changed {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 20%, transparent);
  }

  .llm-manifest-card.is-stable {
    opacity: 0.82;
  }

  .llm-manifest-card.is-skipped {
    opacity: 0.5;
    filter: saturate(0.7);
  }

  .llm-manifest-card.history-ephemeral {
    border-style: dashed;
  }

  .llm-manifest-card-top {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: flex-start;
    margin-bottom: 0.3rem;
  }

  .llm-manifest-heading {
    min-width: 0;
  }

  .llm-manifest-label {
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .llm-manifest-name {
    font-size: 0.64rem;
    opacity: 0.55;
    font-family: ui-monospace, monospace;
  }

  .llm-manifest-source {
    font-size: 0.66rem;
    opacity: 0.62;
    font-family: ui-monospace, monospace;
    margin-bottom: 0.35rem;
    word-break: break-all;
  }

  .llm-manifest-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.45rem;
  }

  .llm-manifest-preview {
    font-size: 0.7rem;
    line-height: 1.4;
    opacity: 0.75;
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  .llm-manifest-hover {
    display: none;
    position: absolute;
    left: 0;
    top: calc(100% + 0.45rem);
    width: min(360px, 82vw);
    padding: 0.7rem 0.8rem;
    border-radius: 0.55rem;
    border: 1px solid color-mix(in srgb, var(--color-base-content) 16%, transparent);
    background: color-mix(in srgb, var(--color-base-300) 90%, black 10%);
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.22);
    z-index: 30;
    pointer-events: none;
  }

  .llm-manifest-card:hover .llm-manifest-hover {
    display: block;
  }

  .llm-manifest-hover-title {
    font-size: 0.78rem;
    font-weight: 700;
    margin-bottom: 0.45rem;
  }

  .llm-manifest-hover-row {
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
    font-size: 0.68rem;
    margin-bottom: 0.18rem;
  }

  .llm-manifest-hover-row span {
    opacity: 0.58;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .llm-manifest-hover-row strong {
    font-weight: 600;
    text-align: right;
    word-break: break-word;
  }

  .llm-manifest-hover-preview {
    margin-top: 0.5rem;
    padding-top: 0.45rem;
    border-top: 1px solid color-mix(in srgb, var(--color-base-content) 10%, transparent);
    font-size: 0.7rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.82;
    max-height: 180px;
    overflow: auto;
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

  /* ── Extra Body styles ── */
  .llm-extra-body-badge {
    font-size: 0.65rem;
    color: var(--color-accent);
    cursor: help;
    opacity: 0.8;
    font-weight: 600;
  }

  .llm-detail-extra-body {
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    border-radius: 0.375rem;
    border-left: 3px solid var(--color-accent);
  }

  .llm-extra-body-json {
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    opacity: 0.85;
    line-height: 1.5;
  }

  /* ── Retry styles ── */
  .llm-row-retry-badge {
    font-size: 0.6rem;
    color: var(--color-warning);
    flex-shrink: 0;
    font-weight: 700;
  }

  .llm-retry-btn {
    margin-left: 0.5rem;
    font-size: 0.65rem;
  }

  .llm-retry-entry {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.75rem;
    margin-bottom: 0.2rem;
    background: color-mix(in srgb, var(--color-warning) 6%, transparent);
    border-radius: 0.375rem;
    border-left: 3px solid var(--color-warning);
    font-size: 0.7rem;
    flex-wrap: wrap;
  }

  .llm-retry-attempt {
    font-weight: 700;
    color: var(--color-warning);
    flex-shrink: 0;
  }

  .llm-retry-delay {
    opacity: 0.7;
    flex-shrink: 0;
  }

  .llm-retry-error {
    opacity: 0.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 400px;
  }

  .llm-retry-time {
    opacity: 0.4;
    font-size: 0.6rem;
    margin-left: auto;
    flex-shrink: 0;
  }

  /* ── Load more ── */
  .llm-load-more {
    padding: 0.5rem 0.75rem;
    text-align: center;
  }

  /* ── Mobile ── */
  @media (max-width: 768px) {
    .llm-log-layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
      height: calc(100vh - 200px);
    }
    .llm-log-left {
      border-right: none;
      border-bottom: 1px solid color-mix(in srgb, var(--color-base-content) 10%, transparent);
      max-height: 35vh;
      min-height: 0;
    }
    .llm-log-right { min-height: 0; }
    .llm-log-row { gap: 0.2rem; padding: 0.3rem 0.5rem; font-size: 0.65rem; }
    .llm-row-model { max-width: 80px; }
    .llm-row-duration { font-size: 0.6rem; }
    .llm-row-manifest { font-size: 0.58rem; }
    .llm-detail-header-top { font-size: 0.65rem; }
    .llm-detail-nav-bar { flex-wrap: wrap; }
    .llm-detail-msg-content { font-size: 0.7rem; }
    .llm-detail-response-body { font-size: 0.7rem; padding: 0.4rem 0.5rem; }
    .llm-export-input { width: 130px; }
    .llm-manifest-grid { grid-template-columns: 1fr; }
    .llm-manifest-hover { width: min(300px, 75vw); }
  }
</style>
