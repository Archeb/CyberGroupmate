<script>
  import { wsStatus, appState } from '../lib/stores.js';
</script>

<div class="navbar bg-base-100 shadow-lg sticky top-0 z-50">
  <div class="flex-1">
    <span class="text-xl font-bold px-4">🤖 <span class="navbar-title-text">CyberGroupmate Dashboard</span></span>
  </div>
  <div class="flex-none gap-2">
    <div class="badge" class:badge-success={$wsStatus === 'connected'} class:badge-error={$wsStatus !== 'connected'}>
      {$wsStatus === 'connected' ? '已连接' : '断开'}
    </div>
    <div class="text-sm opacity-60 navbar-tick">
      Tick: {$appState.mainLoop?.tickCount ?? '-'}
    </div>
  </div>
</div>

<style>
  @media (max-width: 768px) {
    .navbar-title-text { display: none; }
    .navbar-tick { display: none; }
  }
</style>
