<script>
  import { activeMemoryTab, activeTab } from '../lib/stores.js';
  import PersonsTab from './memory/PersonsTab.svelte';
  import ProfilesTab from './memory/ProfilesTab.svelte';
  import GroupsTab from './memory/GroupsTab.svelte';
  import FactsTab from './memory/FactsTab.svelte';
  import InteractionsTab from './memory/InteractionsTab.svelte';
  import RecallTab from './memory/RecallTab.svelte';
  import MemoryEditModal from './MemoryEditModal.svelte';

  const subTabs = [
    { id: 'm-persons', label: '👤 用户画像' },
    { id: 'm-profiles', label: '🏷 群内画像' },
    { id: 'm-groups', label: '🏠 群组画像' },
    { id: 'm-facts', label: '💡 核心事实' },
    { id: 'm-interactions', label: '📝 交互日志' },
    { id: 'm-recall', label: '🔍 记忆搜索' },
  ];

  function switchTab(id) { activeMemoryTab.set(id); }
</script>

<!-- Sub-tab nav -->
<div role="tablist" class="tabs tabs-box tabs-sm mb-3">
  {#each subTabs as tab}
    <a role="tab" class="tab" class:tab-active={$activeMemoryTab === tab.id}
       onclick={() => switchTab(tab.id)}>{tab.label}</a>
  {/each}
</div>

<div class:hidden={$activeMemoryTab !== 'm-persons'}><PersonsTab /></div>
<div class:hidden={$activeMemoryTab !== 'm-profiles'}><ProfilesTab /></div>
<div class:hidden={$activeMemoryTab !== 'm-groups'}><GroupsTab /></div>
<div class:hidden={$activeMemoryTab !== 'm-facts'}><FactsTab /></div>
<div class:hidden={$activeMemoryTab !== 'm-interactions'}><InteractionsTab /></div>
<div class:hidden={$activeMemoryTab !== 'm-recall'}><RecallTab /></div>

<MemoryEditModal />
