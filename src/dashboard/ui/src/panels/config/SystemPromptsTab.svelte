<script>
  export let promptsLoading = false;
  export let promptTree = {};
  export let expandedDirs;
  export let selectedPrompt = null;
  export let promptDetailLoading = false;
  export let promptHasOverride = false;
  export let promptEditorContent = "";
  export let promptSaving = false;
  export let promptOriginal = "";
  export let selectPrompt;
  export let savePromptOverride;
  export let resetPromptEditor;
  export let deletePromptOverride;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-file-lines opacity-50 mr-1"></i> System Prompts Override
</h3>
<p class="text-xs opacity-50 mb-3">
  编辑 system prompt 的 override 版本。Override 保存到 <code>workspace/system-prompts-overrides/</code>，读取时优先使用。
</p>

{#if promptsLoading}
  <div class="flex justify-center py-8">
    <span class="loading loading-spinner loading-md"></span>
  </div>
{:else}
  <div class="flex gap-3 prompt-editor-layout">
    <div class="prompt-tree-panel">
      {#each Object.entries(promptTree) as [dirName, dirNode]}
        {@const dirPath = dirName}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="prompt-dir"
          on:click={() => {
            expandedDirs.has(dirPath) ? expandedDirs.delete(dirPath) : expandedDirs.add(dirPath);
            expandedDirs = expandedDirs;
          }}
        >
          <i class="fa-solid fa-chevron-right text-[10px] opacity-40 transition-transform" style:transform={expandedDirs.has(dirPath) ? "rotate(90deg)" : ""}></i>
          <i class="fa-solid fa-folder text-xs opacity-60"></i>
          <span class="text-xs font-semibold">{dirName}</span>
        </div>
        {#if expandedDirs.has(dirPath) && dirNode.__children}
          {#each Object.entries(dirNode.__children) as [fileName, fileNode]}
            {#if fileNode.__file}
              {@const fp = fileNode.__file}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="prompt-file"
                class:active={selectedPrompt === fp.relativePath}
                on:click={() => selectPrompt(fp.relativePath)}
              >
                <i class="fa-solid fa-file-lines text-xs opacity-40"></i>
                <span class="text-xs truncate">{fileName}</span>
                {#if fp.hasOverride}
                  <span class="badge badge-xs badge-warning ml-auto">override</span>
                {/if}
              </div>
            {/if}
          {/each}
        {/if}
      {/each}
    </div>

    <div class="flex-1 min-w-0">
      {#if !selectedPrompt}
        <div class="flex items-center justify-center h-40 opacity-30 text-sm">
          <i class="fa-solid fa-arrow-left mr-2"></i>选择一个 prompt 文件进行编辑
        </div>
      {:else if promptDetailLoading}
        <div class="flex justify-center py-8">
          <span class="loading loading-spinner loading-md"></span>
        </div>
      {:else}
        <div class="flex items-center gap-2 mb-2">
          <span class="font-mono text-xs font-bold truncate">{selectedPrompt}</span>
          {#if promptHasOverride}
            <span class="badge badge-xs badge-warning">已覆盖</span>
          {:else}
            <span class="badge badge-xs badge-ghost">原始</span>
          {/if}
        </div>
        <textarea
          class="textarea textarea-bordered w-full font-mono text-xs prompt-textarea"
          rows="20"
          bind:value={promptEditorContent}
          spellcheck="false"
        ></textarea>
        <div class="flex gap-2 mt-2">
          <button class="btn btn-sm btn-primary" on:click={savePromptOverride} disabled={promptSaving}>
            <i class="fa-solid fa-floppy-disk"></i>
            {promptSaving ? "保存中..." : "保存 Override"}
          </button>
          <button class="btn btn-sm btn-ghost" on:click={resetPromptEditor} title="恢复编辑器内容为原始版本">
            <i class="fa-solid fa-arrow-rotate-left"></i> 重置为原始
          </button>
          {#if promptHasOverride}
            <button class="btn btn-sm btn-outline btn-error" on:click={deletePromptOverride} title="删除 override 文件，恢复到原始版本">
              <i class="fa-solid fa-trash-can"></i> 删除 Override
            </button>
          {/if}
        </div>
        {#if promptHasOverride}
          <div class="mt-3">
            <details class="collapse collapse-arrow bg-base-200 rounded-lg">
              <summary class="collapse-title text-xs font-medium py-2 min-h-0">
                <i class="fa-solid fa-eye mr-1 opacity-50"></i>查看原始版本
              </summary>
              <div class="collapse-content">
                <pre class="text-xs opacity-60 whitespace-pre-wrap mt-1">{promptOriginal}</pre>
              </div>
            </details>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
