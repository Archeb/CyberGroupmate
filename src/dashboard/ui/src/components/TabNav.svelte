<script>
  import { activeTab, topicDetailId } from '../lib/stores.js';

  const tabs = [
    { id: 'messages', label: '消息流', icon: 'M17.74 30L16 29l4-7h6a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9v2H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4h20a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-4.84z' },
    { id: 'topics', label: '话题注册', icon: 'M4 6h24v2H4zm0 6h24v2H4zm0 6h24v2H4zm0 6h24v2H4z' },
    { id: 'queue', label: '注意力队列', icon: 'M11.61 29.92a1 1 0 0 1-.6-1.07L12.83 17H8a1 1 0 0 1-1-1.23l3-13A1 1 0 0 1 11 2h10a1 1 0 0 1 .78 1.63L17.4 9H24a1 1 0 0 1 .78 1.63l-13 16a1 1 0 0 1-1.17.29z' },
    { id: 'decisions', label: '决策日志', icon: 'M16 2a14 14 0 1 0 14 14A14 14 0 0 0 16 2zm0 26a12 12 0 0 1 0-24v12l8.49 8.49A11.95 11.95 0 0 1 16 28z' },
    { id: 'codeact', label: 'CodeAct', icon: 'M31 16l-7 7-1.41-1.41L28.17 16l-5.58-5.59L24 9l7 7zM1 16l7-7 1.41 1.41L3.83 16l5.58 5.59L8 23l-7-7zm11.85 14H15l4.15-28h-2.15l-4.15 28z' },
    { id: 'llm-log', label: 'LLM 日志', icon: 'M16 7a3 3 0 1 0 3 3 3 3 0 0 0-3-3zm0 4a1 1 0 1 1 1-1 1 1 0 0 1-1 1z', icon2: 'M23 3H9a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 24H9V5h14z', icon3: 'M20 19H12v2h8zm0 4H12v2h8z' },
    { id: 'token-stats', label: 'Token 统计', icon: 'M2 28h28v2H2zM4 26h2V14H4zm5 0h2V10H9zm5 0h2V16h-2zm5 0h2V6h-2zm5 0h2V12h-2z' },
    { id: 'memory', label: '记忆查询', memoryIcon: true },
    { id: 'stickers', label: '贴纸管理', icon: 'M16 2A14 14 0 0 0 2 16a14.16 14.16 0 0 0 13.86 14H16a14 14 0 0 0 0-28zm0 26a12 12 0 0 1-5.28-1.22A14 14 0 0 0 16 16.58a14 14 0 0 0 5.28 10.2A11.93 11.93 0 0 1 16 28zM10 12a2 2 0 1 1 2 2 2 2 0 0 1-2-2zm8 0a2 2 0 1 1 2 2 2 2 0 0 1-2-2z' },
    { id: 'config', label: '配置编辑', icon: 'M13.78 26H8V6h14v6.78l2-2V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h7.78zM10 10h8v2H10zm0 6h4v2h-4zM29.84 17.16l-2-2a.9.9 0 0 0-1.27 0L19 22.74V27h4.26l7.58-7.58a.9.9 0 0 0 0-1.26zM22.42 25H21v-1.42l5.57-5.57 1.42 1.42z' },
    { id: 'system', label: '系统状态', icon: 'M27 16.76V16v-.77l1.92-1.68A2 2 0 0 0 29.3 11l-2.36-4a2 2 0 0 0-1.73-1 2 2 0 0 0-.64.1l-2.43.82a11.35 11.35 0 0 0-1.31-.75l-.51-2.52a2 2 0 0 0-2-1.61h-4.68a2 2 0 0 0-2 1.61l-.51 2.52a11.48 11.48 0 0 0-1.32.75l-2.38-.86A2 2 0 0 0 6.79 7a2 2 0 0 0-1.73 1L2.7 12a2 2 0 0 0 .41 2.51L5 16.14v.65l.05.52-1.92 1.68a2 2 0 0 0-.41 2.54l2.36 4a2 2 0 0 0 1.73 1 2 2 0 0 0 .64-.1l2.43-.82a11.35 11.35 0 0 0 1.31.75l.51 2.52a2 2 0 0 0 2 1.61h4.72a2 2 0 0 0 2-1.61l.51-2.52a11.48 11.48 0 0 0 1.32-.75l2.42.82a2 2 0 0 0 .64.1 2 2 0 0 0 1.73-1l2.28-4a2 2 0 0 0-.41-2.54zM25.21 24l-3.43-1.16a8.86 8.86 0 0 1-2.71 1.57L18.36 28h-4.72l-.71-3.55a9.36 9.36 0 0 1-2.7-1.57L6.79 24l-2.36-4 2.72-2.4a8.9 8.9 0 0 1 0-3.13L4.43 12l2.36-4 3.43 1.16a8.86 8.86 0 0 1 2.71-1.57L13.64 4h4.72l.71 3.55a9.36 9.36 0 0 1 2.7 1.57L25.21 8l2.36 4-2.72 2.4a8.9 8.9 0 0 1 0 3.13L27.57 20zM16 22a6 6 0 1 1 6-6 5.94 5.94 0 0 1-6 6zm0-10a4 4 0 1 0 4 4 4 4 0 0 0-4-4z' },
  ];

  function switchTab(id) {
    activeTab.set(id);
  }
</script>

<div role="tablist" class="tabs tabs-box tab-nav mb-4">
  {#each tabs as tab}
    <button role="tab" tabindex="0" class="tab" class:tab-active={$activeTab === tab.id}
       onclick={() => switchTab(tab.id)}>
      <span class="tab-icon">
        {#if tab.memoryIcon}
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 576 512">
            <path d="M208 0c-29.9 0-54.7 20.5-61.8 48.2c-.8 0-1.4-.2-2.2-.2c-35.3 0-64 28.7-64 64c0 4.8.6 9.5 1.7 14C52.5 138 32 166.6 32 200c0 12.6 3.2 24.3 8.3 34.9C16.3 248.7 0 274.3 0 304c0 33.3 20.4 61.9 49.4 73.9c-.9 4.6-1.4 9.3-1.4 14.1c0 39.8 32.2 72 72 72c4.1 0 8.1-.5 12-1.2c9.6 28.5 36.2 49.2 68 49.2c39.8 0 72-32.2 72-72V64c0-35.3-28.7-64-64-64zm368 304c0-29.7-16.3-55.3-40.3-69.1c5.2-10.6 8.3-22.3 8.3-34.9c0-33.4-20.5-62-49.7-74c1-4.5 1.7-9.2 1.7-14c0-35.3-28.7-64-64-64c-.8 0-1.5.2-2.2.2C422.7 20.5 397.9 0 368 0c-35.3 0-64 28.6-64 64v376c0 39.8 32.2 72 72 72c31.8 0 58.4-20.7 68-49.2c3.9.7 7.9 1.2 12 1.2c39.8 0 72-32.2 72-72c0-4.8-.5-9.5-1.4-14.1c29-12 49.4-40.6 49.4-73.9z" fill="currentColor"></path>
          </svg>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 32 32" fill="currentColor">
            <path d={tab.icon} />
            {#if tab.icon2}<path d={tab.icon2} />{/if}
            {#if tab.icon3}<path d={tab.icon3} />{/if}
          </svg>
        {/if}
      </span>
      {tab.label}
    </button>
  {/each}

  {#if $topicDetailId}
    <button role="tab" tabindex="0" class="tab" class:tab-active={$activeTab === 'topic-detail'}
       onclick={() => switchTab('topic-detail')}>
      <span class="tab-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 32 32" fill="currentColor">
          <path d="M19 10h7v2h-7zm0 5h7v2h-7zm0 5h7v2h-7zM6 10h7v2H6zm0 5h7v2H6zm0 5h7v2H6z" />
          <path d="M28 5H4a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h24a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zM4 7h11v18H4zm13 18V7h11v18z" />
        </svg>
      </span>
      话题详情
    </button>
  {/if}
</div>

