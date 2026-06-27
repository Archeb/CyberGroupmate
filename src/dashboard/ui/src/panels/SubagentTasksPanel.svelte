<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { getGroupLabel } from '../lib/utils.js';

  let tasks = [];
  let total = 0;
  let hasMore = false;
  let loading = false;
  let offset = 0;
  let status = '';
  let chatId = '';
  let selectedTask = null;
  let selectedLoading = false;
  const limit = 40;

  onMount(() => refresh());

  async function refresh(reset = true) {
    if (loading) return;
    loading = true;
    if (reset) offset = 0;
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (status) params.set('status', status);
    if (chatId.trim()) params.set('chatId', chatId.trim());
    try {
      const result = await api(`/subagent-tasks?${params.toString()}`);
      total = result.total ?? 0;
      hasMore = !!result.hasMore;
      tasks = reset ? (result.tasks || []) : [...tasks, ...(result.tasks || [])];
      offset = tasks.length;
      if (!selectedTask && tasks.length > 0) {
        await selectTask(tasks[0].taskId);
      } else if (selectedTask) {
        const stillVisible = tasks.some((task) => task.taskId === selectedTask.taskId);
        if (!stillVisible && reset) selectedTask = null;
      }
    } finally {
      loading = false;
    }
  }

  async function selectTask(taskId) {
    selectedLoading = true;
    try {
      selectedTask = await api(`/subagent-tasks/${taskId}`);
    } finally {
      selectedLoading = false;
    }
  }

  function statusClass(value) {
    switch (value) {
      case 'COMPLETED': return 'badge-success';
      case 'RUNNING': return 'badge-warning';
      case 'PENDING': return 'badge-info';
      case 'ERROR': return 'badge-error';
      case 'TIMEOUT': return 'badge-error';
      case 'SKIPPED': return 'badge-ghost';
      default: return 'badge-ghost';
    }
  }

  function short(text, len = 120) {
    const value = String(text || '');
    return value.length > len ? `${value.slice(0, len)}...` : value;
  }

  function fmt(iso) {
    return iso ? new Date(iso).toLocaleString() : '-';
  }
</script>

<div class="tasks-layout">
  <div class="tasks-list card bg-base-100">
    <div class="card-body p-3 min-h-0">
      <div class="flex items-center justify-between gap-2 mb-3">
        <h3 class="card-title text-sm">Subagent 任务</h3>
        <button class="btn btn-xs btn-ghost" onclick={() => refresh(true)} disabled={loading}>刷新</button>
      </div>

      <div class="filters">
        <select class="select select-bordered select-xs" bind:value={status} onchange={() => refresh(true)}>
          <option value="">全部状态</option>
          <option value="PENDING">PENDING</option>
          <option value="RUNNING">RUNNING</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="ERROR">ERROR</option>
          <option value="SKIPPED">SKIPPED</option>
          <option value="TIMEOUT">TIMEOUT</option>
        </select>
        <input
          class="input input-bordered input-xs"
          placeholder="chatId"
          bind:value={chatId}
          onkeydown={(event) => { if (event.key === 'Enter') refresh(true); }}
        />
      </div>

      <div class="text-xs opacity-60 mb-2">共 {total} 条</div>

      <div class="task-scroll">
        {#each tasks as task}
          <button
            class="task-row"
            class:active={selectedTask?.taskId === task.taskId}
            onclick={() => selectTask(task.taskId)}
            title={task.taskId}
          >
            <div class="row-top">
              <span class="badge badge-xs {statusClass(task.status)}">{task.status}</span>
              <span class="task-time">{fmt(task.createdAt)}</span>
            </div>
            <div class="task-title">{getGroupLabel(task.chatId)}</div>
            <div class="task-direction">{short(task.contentDirection)}</div>
            <div class="task-id">{task.taskId}</div>
          </button>
        {/each}
        {#if tasks.length === 0 && !loading}
          <div class="empty">没有匹配的任务</div>
        {/if}
      </div>

      {#if hasMore}
        <button class="btn btn-xs btn-block mt-2" onclick={() => refresh(false)} disabled={loading}>
          {loading ? '加载中...' : '加载更多'}
        </button>
      {/if}
    </div>
  </div>

  <div class="task-detail card bg-base-100 overflow-y-auto">
    <div class="card-body p-4 min-h-0">
      {#if selectedLoading}
        <h3 class="card-title text-sm">加载中...</h3>
      {:else if selectedTask}
        <div class="detail-head">
          <h3 class="card-title text-sm">任务详情</h3>
          <span class="badge {statusClass(selectedTask.status)}">{selectedTask.status}</span>
        </div>

        <div class="detail-grid">
          <div><span>Task ID</span><code>{selectedTask.taskId}</code></div>
          <div><span>群组</span><code>{getGroupLabel(selectedTask.chatId)}</code></div>
          <div><span>创建</span><code>{fmt(selectedTask.createdAt)}</code></div>
          <div><span>更新</span><code>{fmt(selectedTask.updatedAt)}</code></div>
          {#if selectedTask.completedAt}<div><span>完成</span><code>{fmt(selectedTask.completedAt)}</code></div>{/if}
          {#if selectedTask.sessionId}<div><span>Session</span><code>{selectedTask.sessionId}</code></div>{/if}
          {#if selectedTask.durationMs != null}<div><span>耗时</span><code>{selectedTask.durationMs} ms</code></div>{/if}
        </div>

        <section>
          <h4>Content Direction</h4>
          <pre>{selectedTask.contentDirection}</pre>
        </section>

        {#if selectedTask.toneGuidance}
          <section>
            <h4>Tone Guidance</h4>
            <pre>{selectedTask.toneGuidance}</pre>
          </section>
        {/if}

        {#if selectedTask.sentMessages?.length}
          <section>
            <h4>已发送消息</h4>
            <div class="sent-list">
              {#each selectedTask.sentMessages as msg}
                <div class="sent-item">
                  <span>{fmt(msg.timestamp)}</span>
                  <p>{msg.text}</p>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if selectedTask.error}
          <section>
            <h4>错误</h4>
            <pre class="error-block">{selectedTask.error}</pre>
          </section>
        {/if}

        {#if selectedTask.context != null}
          <section>
            <h4>Context</h4>
            <pre>{JSON.stringify(selectedTask.context, null, 2)}</pre>
          </section>
        {/if}

        {#if selectedTask.summary}
          <section>
            <h4>Callback Summary</h4>
            <pre>{selectedTask.summary}</pre>
          </section>
        {/if}
      {:else}
        <span class="opacity-60 text-sm">选择一条任务查看详情</span>
      {/if}
    </div>
  </div>
</div>

<style>
.muted { font-weight: 400; opacity: 0.5; font-size: 0.75rem; }
.tasks-layout {
  display: grid;
  grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
  gap: 1rem;
  height: calc(100vh - 280px);
  min-height: 30rem;
}

.tasks-list,
.task-detail {
  min-height: 0;
}

.filters {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.task-scroll {
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.task-row {
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--color-base-content) 8%, transparent);
  background: color-mix(in srgb, var(--color-base-200) 45%, transparent);
  border-radius: 0.375rem;
  padding: 0.55rem;
  cursor: pointer;
}

.task-row:hover,
.task-row.active {
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.row-top,
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.task-time,
.task-id,
.task-direction,
.empty {
  font-size: 0.72rem;
  opacity: 0.65;
}

.task-title {
  font-size: 0.85rem;
  font-weight: 600;
  margin-top: 0.25rem;
}

.task-direction {
  margin-top: 0.25rem;
  line-height: 1.35;
}

.task-id {
  font-family: var(--font-mono);
  margin-top: 0.25rem;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.5rem;
  margin: 0.75rem 0;
}

.detail-grid div {
  border-radius: 0.375rem;
  background: var(--color-base-200);
  padding: 0.5rem;
  min-width: 0;
}

.detail-grid span {
  display: block;
  font-size: 0.68rem;
  opacity: 0.6;
  margin-bottom: 0.2rem;
}

.detail-grid code,
pre {
  white-space: pre-wrap;
  word-break: break-word;
}

section {
  margin-top: 0.85rem;
}

h4 {
  font-size: 0.75rem;
  font-weight: 700;
  margin-bottom: 0.35rem;
  opacity: 0.75;
}

pre {
  font-size: 0.75rem;
  line-height: 1.45;
  border-radius: 0.375rem;
  background: var(--color-base-200);
  padding: 0.65rem;
  max-height: 18rem;
  overflow: auto;
}

.error-block {
  color: var(--color-error);
}

.sent-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.sent-item {
  border-left: 3px solid var(--color-success);
  background: color-mix(in srgb, var(--color-success) 7%, transparent);
  border-radius: 0.375rem;
  padding: 0.5rem;
}

.sent-item span {
  font-size: 0.68rem;
  opacity: 0.6;
}

.sent-item p {
  font-size: 0.78rem;
  margin-top: 0.2rem;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 900px) {
  .tasks-layout {
    grid-template-columns: 1fr;
    height: auto;
  }
  .tasks-list {
    max-height: 22rem;
  }
}
</style>
