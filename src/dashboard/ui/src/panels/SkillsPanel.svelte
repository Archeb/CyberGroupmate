<script>
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import MonacoEditor from '../components/MonacoEditor.svelte';

  let skills = [];
  let loading = false;
  let detailLoading = false;
  let saving = false;
  let reloading = false;
  let selectedSkillId = null;
  let selectedFile = 'entry';
  let entryFileName = 'index.ts';
  let dtsFileName = '';
  let entryContent = '';
  let dtsContent = '';
  let skillMdContent = '';
  let notice = null;
  let skillsLoaded = false;

  $: if ($activeTab === 'skills' && !loading && !skillsLoaded) {
    loadSkills();
  }

  function showNotice(message, type = 'info') {
    notice = { message, type };
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => {
      notice = null;
    }, type === 'error' ? 8000 : 4000);
  }

  async function loadSkills() {
    loading = true;
    try {
      const res = await api('/skills');
      skills = res.skills || [];
      skillsLoaded = true;
      if (!selectedSkillId && skills.length > 0) {
        await selectSkill(skills[0].id);
      } else if (selectedSkillId && skills.some((skill) => skill.id === selectedSkillId)) {
        await selectSkill(selectedSkillId);
      } else if (selectedSkillId) {
        selectedSkillId = null;
      }
    } catch (err) {
      showNotice('加载 Skills 失败: ' + err, 'error');
    } finally {
      loading = false;
    }
  }

  async function selectSkill(skillId) {
    selectedSkillId = skillId;
    detailLoading = true;
    try {
      const res = await api('/skills/' + skillId);
      const skill = res.skill;
      entryFileName = skill.entryFileName || 'index.ts';
      dtsFileName = skill.dtsFileName || `${skillId}.d.ts`;
      entryContent = skill.files.entry.content || '';
      dtsContent = skill.files.dts.content || '';
      skillMdContent = skill.files.skillMd.content || '';
      selectedFile = 'entry';
    } catch (err) {
      showNotice('加载 Skill 详情失败: ' + err, 'error');
    }
    detailLoading = false;
  }

  async function saveSkill() {
    if (!selectedSkillId) return;
    saving = true;
    try {
      const res = await api('/skills/' + selectedSkillId, {
        method: 'PUT',
        body: {
          entryFileName,
          dtsFileName,
          entryContent,
          dtsContent,
          skillMdContent,
        },
      });
      if (res.ok) {
        showNotice('Skill 文件已保存', 'success');
        await loadSkills();
      } else {
        showNotice('保存失败: ' + (res.error || '未知错误'), 'error');
      }
    } catch (err) {
      showNotice('保存失败: ' + err, 'error');
    }
    saving = false;
  }

  async function reloadSkills() {
    reloading = true;
    try {
      const res = await api('/skills/reload', { method: 'POST' });
      if (res.ok) {
        const failed = (res.sandboxResults || []).filter((item) => !item.ok);
        if (failed.length > 0) {
          showNotice(`已触发重载，但有 ${failed.length} 个 sandbox 失败`, 'warning');
        } else {
          showNotice(`已重载 ${res.activeSandboxCount} 个活跃 sandbox`, 'success');
        }
      } else {
        showNotice('重载失败: ' + (res.error || '未知错误'), 'error');
      }
    } catch (err) {
      showNotice('重载失败: ' + err, 'error');
    }
    reloading = false;
  }

  function getLanguage(fileKey) {
    if (fileKey === 'entry') return entryFileName.endsWith('.js') ? 'javascript' : 'typescript';
    if (fileKey === 'dts') return 'typescript';
    return 'markdown';
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
      <div>
        <h3 class="card-title text-sm">
          <i class="fa-solid fa-screwdriver-wrench opacity-50 mr-1"></i> Skill 编辑器
        </h3>
        <p class="text-xs opacity-50 mt-1">
          快速编辑 workspace/skills 下的入口文件、类型声明和 SKILL.md，并把变更热推到活跃 sandbox。
        </p>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-sm btn-ghost" on:click={loadSkills} disabled={loading}>
          <i class="fa-solid fa-rotate"></i> 刷新
        </button>
        <button class="btn btn-sm btn-outline btn-info" on:click={reloadSkills} disabled={reloading}>
          <i class="fa-solid fa-bolt"></i>
          {reloading ? '重载中...' : '热重载 Skills'}
        </button>
        <button class="btn btn-sm btn-primary" on:click={saveSkill} disabled={saving || !selectedSkillId}>
          <i class="fa-solid fa-floppy-disk"></i>
          {saving ? '保存中...' : '保存 Skill'}
        </button>
      </div>
    </div>

    {#if loading}
      <div class="flex justify-center py-10">
        <span class="loading loading-spinner loading-lg"></span>
      </div>
    {:else}
      <div class="skills-layout">
        <div class="skills-sidebar">
          {#if skills.length === 0}
            <div class="text-sm opacity-40 p-4">当前还没有可编辑的 Skill 目录。</div>
          {:else}
            {#each skills as skill}
              <button
                class="skill-item"
                class:active={selectedSkillId === skill.id}
                on:click={() => selectSkill(skill.id)}
              >
                <span class="font-mono text-sm truncate">{skill.id}</span>
                <span class="flex gap-1 flex-wrap justify-end">
                  {#if skill.loaded}
                    <span class="badge badge-xs badge-success">loaded</span>
                  {/if}
                  {#if skill.hasSkillMd}
                    <span class="badge badge-xs badge-ghost">md</span>
                  {/if}
                </span>
              </button>
            {/each}
          {/if}
        </div>

        <div class="flex-1 min-w-0">
          {#if !selectedSkillId}
            <div class="flex items-center justify-center h-64 text-sm opacity-30">
              选择一个 Skill 开始编辑
            </div>
          {:else if detailLoading}
            <div class="flex justify-center py-10">
              <span class="loading loading-spinner loading-lg"></span>
            </div>
          {:else}
            <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <div>
                <div class="font-mono text-sm font-bold">{selectedSkillId}</div>
                <div class="text-xs opacity-50 mt-1">
                  实际文件：{entryFileName} / {dtsFileName} / SKILL.md
                </div>
              </div>
              <div class="join">
                <button class="btn btn-sm join-item" class:btn-active={selectedFile === 'entry'} on:click={() => (selectedFile = 'entry')}>
                  {entryFileName}
                </button>
                <button class="btn btn-sm join-item" class:btn-active={selectedFile === 'dts'} on:click={() => (selectedFile = 'dts')}>
                  {dtsFileName}
                </button>
                <button class="btn btn-sm join-item" class:btn-active={selectedFile === 'skillMd'} on:click={() => (selectedFile = 'skillMd')}>
                  skill.md
                </button>
              </div>
            </div>

            {#if selectedFile === 'entry'}
              <MonacoEditor bind:value={entryContent} language={getLanguage('entry')} height={520} />
            {:else if selectedFile === 'dts'}
              <MonacoEditor bind:value={dtsContent} language={getLanguage('dts')} height={520} />
            {:else}
              <MonacoEditor bind:value={skillMdContent} language={getLanguage('skillMd')} height={520} wordWrap="bounded" />
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    {#if notice}
      <div class="mt-3 alert py-2 px-3"
        class:alert-success={notice.type === 'success'}
        class:alert-error={notice.type === 'error'}
        class:alert-warning={notice.type === 'warning'}
        class:alert-info={notice.type === 'info'}
      >
        <span class="text-sm">{notice.message}</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .skills-layout {
    display: flex;
    gap: 1rem;
    min-height: 36rem;
  }

  .skills-sidebar {
    width: 15rem;
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--color-base-content) 10%, transparent);
    border-radius: 0.75rem;
    padding: 0.5rem;
    max-height: 36rem;
    overflow-y: auto;
  }

  .skill-item {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.55rem 0.65rem;
    border: none;
    border-radius: 0.55rem;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .skill-item:hover {
    background: var(--color-base-200);
  }

  .skill-item.active {
    background: color-mix(in srgb, var(--color-primary) 16%, transparent);
    color: var(--color-primary);
  }

  @media (max-width: 900px) {
    .skills-layout {
      flex-direction: column;
    }

    .skills-sidebar {
      width: 100%;
      max-height: 14rem;
    }
  }
</style>
