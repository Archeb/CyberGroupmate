<script>
  import { onMount } from 'svelte';
  import { connectWS } from './lib/ws.js';
  import { api } from './lib/api.js';
  import { appState, activeTab, topicDetailId, messages } from './lib/stores.js';
  import Navbar from './components/Navbar.svelte';
  import StatsBar from './components/StatsBar.svelte';
  import TabNav from './components/TabNav.svelte';
  import MessagesPanel from './panels/MessagesPanel.svelte';
  import TopicsPanel from './panels/TopicsPanel.svelte';
  import QueuePanel from './panels/QueuePanel.svelte';
  import DecisionsPanel from './panels/DecisionsPanel.svelte';
  import CodeActPanel from './panels/CodeActPanel.svelte';
  import LLMLogPanel from './panels/LLMLogPanel.svelte';
  import TokenStatsPanel from './panels/TokenStatsPanel.svelte';
  import MemoryPanel from './panels/MemoryPanel.svelte';
  import StickersPanel from './panels/StickersPanel.svelte';
  import SystemPanel from './panels/SystemPanel.svelte';
  import TopicDetailPanel from './panels/TopicDetailPanel.svelte';
  import EnqueueModal from './panels/EnqueueModal.svelte';

  let refreshTimer;

  onMount(() => {
    // Auto theme
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    function applyTheme(e) { document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light'); }
    applyTheme(mq);
    mq.addEventListener('change', applyTheme);

    connectWS();
    startPeriodicRefresh();

    return () => {
      if (refreshTimer) clearInterval(refreshTimer);
    };
  });

  function startPeriodicRefresh() {
    refreshTimer = setInterval(async () => {
      try {
        const snapshot = await api('/overview');
        if (Array.isArray(snapshot.queue)) {
          snapshot.queue = { active: snapshot.queue, dequeued: [] };
        }
        appState.set(snapshot);
      } catch { /* ignore */ }
    }, 5000);
  }
</script>

<div class="bg-base-300 min-h-screen">
  <Navbar />

  <div class="container mx-auto p-4">
    <StatsBar />
    <TabNav />

    <div class:hidden={$activeTab !== 'messages'}><MessagesPanel /></div>
    <div class:hidden={$activeTab !== 'topics'}><TopicsPanel /></div>
    <div class:hidden={$activeTab !== 'queue'}><QueuePanel /></div>
    <div class:hidden={$activeTab !== 'decisions'}><DecisionsPanel /></div>
    <div class:hidden={$activeTab !== 'codeact'}><CodeActPanel /></div>
    <div class:hidden={$activeTab !== 'llm-log'}><LLMLogPanel /></div>
    <div class:hidden={$activeTab !== 'token-stats'}><TokenStatsPanel /></div>
    <div class:hidden={$activeTab !== 'memory'}><MemoryPanel /></div>
    <div class:hidden={$activeTab !== 'stickers'}><StickersPanel /></div>
    <div class:hidden={$activeTab !== 'system'}><SystemPanel /></div>
    <div class:hidden={$activeTab !== 'topic-detail'}><TopicDetailPanel /></div>

    <EnqueueModal />
  </div>
</div>
