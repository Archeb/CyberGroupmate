<script>
  import { appState } from '../lib/stores.js';
</script>

<div class="stats shadow w-full mb-4 bg-base-100">
  <div class="stat">
    <div class="stat-title">活跃群组</div>
    <div class="stat-value text-primary">{$appState.groups.length}</div>
  </div>
  <div class="stat">
    <div class="stat-title">Accumulator</div>
    <div class="stat-value text-secondary">{($appState.queue?.active || []).length}</div>
  </div>
  <div class="stat">
    <div class="stat-title">Sandbox 池</div>
    <div class="stat-value text-accent">{$appState.sandboxPool?.inUse || 0}/{$appState.sandboxPool?.total || 0}</div>
  </div>
  <div class="stat">
    <div class="stat-title">待处理回调</div>
    <div class="stat-value text-warning">{($appState.pendingCallbacks || []).length}</div>
  </div>
</div>
