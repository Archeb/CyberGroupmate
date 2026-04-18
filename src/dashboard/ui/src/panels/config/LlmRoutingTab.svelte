<script>
  export let config;
  export let ROUTING_COMPONENTS = [];
  export let routingSnapshot = "";
  export let getRoutingValue;
  export let addRoutingProfile;
  export let removeRoutingProfile;
  export let getProfileNames;
  export let handleRoutingDragStart;
  export let handleRoutingDrop;
  export let handleRoutingDragEnd;
  export let draggedCompKey = null;
  export let draggedItem = null;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-route opacity-50 mr-1"></i> 组件级 LLM 路由
</h3>
<p class="text-xs opacity-50 mb-3">为每个组件分配 LLM profile。支持多个（fallback chain）。</p>
{#key routingSnapshot}
  <div class="space-y-2">
    {#each ROUTING_COMPONENTS as comp}
      {@const assigned = getRoutingValue(comp.key)}
      <div class="routing-row">
        <div class="routing-label">
          <span class="font-mono text-xs font-bold">{comp.key}</span>
          <span class="text-xs opacity-40 ml-1">— {comp.desc}</span>
        </div>
        <div class="flex items-center gap-2 flex-wrap mt-1">
          {#each assigned as pn, idx (pn)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="badge badge-primary badge-sm gap-1 cursor-move transition-opacity"
              draggable="true"
              on:dragstart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                handleRoutingDragStart(comp.key, idx);
              }}
              on:dragend={handleRoutingDragEnd}
              on:dragover|preventDefault
              on:drop|preventDefault={() => handleRoutingDrop(comp.key, idx)}
              class:opacity-40={draggedCompKey === comp.key && draggedItem === idx}
            >
              <span class="opacity-60 text-[10px]">#{idx + 1}</span>
              {pn}
              <button
                class="btn btn-ghost btn-xs px-0 min-h-0 h-auto"
                on:click={() => removeRoutingProfile(comp.key, idx)}
                aria-label="移除路由配置"
              >
                <i class="fa-solid fa-xmark text-[10px]"></i>
              </button>
            </div>
          {/each}
          {#if assigned.length === 0}
            <span class="text-xs opacity-30 italic">未分配</span>
          {/if}
          <select
            class="select select-xs select-bordered w-40"
            on:change={(e) => {
              addRoutingProfile(comp.key, e.target.value);
              e.target.selectedIndex = 0;
            }}
          >
            <option value="" disabled selected>+ 添加...</option>
            {#each getProfileNames().filter((pn) => !assigned.includes(pn)) as pn}
              <option value={pn}>{pn}</option>
            {/each}
          </select>
          <label class="cfg-field" style="flex: 0 0 auto; min-width: 100px;">
            <span class="cfg-label"><i class="fa-solid fa-stopwatch text-[9px] opacity-50 mr-0.5"></i>超时 (ms)</span>
            <input
              type="number"
              class="input input-xs input-bordered w-full"
              value={config.llmRouting.timeouts[comp.key] ?? ""}
              on:input={(e) => {
                const v = Number(e.target.value);
                if (v > 0) {
                  config.llmRouting.timeouts[comp.key] = v;
                } else {
                  delete config.llmRouting.timeouts[comp.key];
                }
                config = config;
              }}
              placeholder="60000"
              min="1000"
              step="1000"
            />
          </label>
        </div>
      </div>
    {/each}
  </div>
{/key}
