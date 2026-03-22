<script>
  import { activeMemoryTab, activeTab } from "../lib/stores.js";
  import PersonsTab from "./memory/PersonsTab.svelte";
  import ProfilesTab from "./memory/ProfilesTab.svelte";
  import GroupsTab from "./memory/GroupsTab.svelte";
  import FactsTab from "./memory/FactsTab.svelte";
  import InteractionsTab from "./memory/InteractionsTab.svelte";
  import RecallTab from "./memory/RecallTab.svelte";
  import MemoryEditModal from "./MemoryEditModal.svelte";

  const subTabs = [
    { id: "m-persons", label: "用户画像", icon: "fa-user" },
    { id: "m-profiles", label: "群内画像", icon: "fa-id-badge" },
    { id: "m-groups", label: "群组画像", icon: "fa-users" },
    { id: "m-facts", label: "核心事实", icon: "fa-lightbulb" },
    { id: "m-interactions", label: "交互日志", icon: "fa-list-check" },
    { id: "m-recall", label: "记忆搜索", icon: "fa-magnifying-glass" },
  ];

  function switchTab(id) {
    activeMemoryTab.set(id);
  }
</script>

<div class="memory-layout">
  <!-- Left Sidebar Nav -->
  <div class="memory-sidebar">
    <div class="card bg-base-100">
      <div class="card-body p-3">
        <h3 class="card-title text-sm mb-1">
          <i class="fa-solid fa-brain opacity-50 mr-1"></i> 记忆系统
        </h3>
        <div class="space-y-0.5">
          {#each subTabs as tab}
            <button
              class="mem-nav-item"
              class:active={$activeMemoryTab === tab.id}
              on:click={() => switchTab(tab.id)}
            >
              <i class="fa-solid {tab.icon} fa-fw"></i>
              <span>{tab.label}</span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- Right Content Area -->
  <div class="memory-content">
    {#key $activeMemoryTab}
      <div class="memory-content-inner">
        {#if $activeMemoryTab === "m-persons"}<PersonsTab />
        {:else if $activeMemoryTab === "m-profiles"}<ProfilesTab />
        {:else if $activeMemoryTab === "m-groups"}<GroupsTab />
        {:else if $activeMemoryTab === "m-facts"}<FactsTab />
        {:else if $activeMemoryTab === "m-interactions"}<InteractionsTab />
        {:else if $activeMemoryTab === "m-recall"}<RecallTab />
        {/if}
      </div>
    {/key}
  </div>
</div>

<MemoryEditModal />

<style>
  /* ── Two-column layout ── */
  .memory-layout {
    display: flex;
    gap: 1rem;
  }

  .memory-sidebar {
    width: 11rem;
    flex-shrink: 0;
  }

  .memory-content {
    flex: 1;
    min-width: 0;
  }

  /* ── Nav items (matches ConfigPanel pattern) ── */
  .mem-nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition:
      background 0.15s,
      opacity 0.15s,
      color 0.15s;
    background: none;
    border: none;
    color: inherit;
    width: 100%;
    opacity: 0.7;
  }
  .mem-nav-item:hover {
    opacity: 1;
    background: var(--color-base-200);
  }
  .mem-nav-item.active {
    opacity: 1;
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
  }
</style>
