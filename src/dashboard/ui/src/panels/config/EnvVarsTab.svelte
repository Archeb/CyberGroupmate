<script>
  export let config;
  export let pwFocus;
  export let pwBlur;
  export let addEnvVar;
  export let removeEnvVar;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-key opacity-50 mr-1"></i>
  环境变量
  <span class="restart-hint"
    ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
  >
</h3>
<p class="text-xs opacity-50 mb-3">
  配置注入到进程的环境变量。每个变量可选择作用于 Host（主进程）、Sandbox（沙盒执行环境）或 Both（两者皆可访问）。
</p>
<div class="overflow-x-auto">
  <table class="table table-xs w-full">
    <thead>
      <tr>
        <th class="text-xs opacity-60" style="width:30%">变量名</th>
        <th class="text-xs opacity-60" style="width:40%">值</th>
        <th class="text-xs opacity-60" style="width:20%">作用域</th>
        <th class="text-xs opacity-60" style="width:10%"></th>
      </tr>
    </thead>
    <tbody>
      {#each (config.envVars || []) as ev, idx}
        <tr class="hover">
          <td>
            <input
              type="text"
              class="input input-xs input-bordered w-full font-mono"
              bind:value={ev.key}
              placeholder="VARIABLE_NAME"
            />
          </td>
          <td>
            <input
              type="password"
              class="input input-xs input-bordered w-full font-mono"
              bind:value={ev.value}
              placeholder="value"
              on:focus={pwFocus}
              on:blur={pwBlur}
            />
          </td>
          <td>
            <select
              class="select select-xs select-bordered w-full"
              bind:value={ev.scope}
            >
              <option value="both">Both</option>
              <option value="host">Host</option>
              <option value="sandbox">Sandbox</option>
            </select>
          </td>
          <td>
            <button
              class="btn btn-xs btn-ghost btn-error"
              on:click={() => removeEnvVar(idx)}
              title="删除"
            >
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </td>
        </tr>
      {/each}
      {#if !config.envVars || config.envVars.length === 0}
        <tr>
          <td colspan="4" class="text-center text-xs opacity-30 py-4">
            暂无环境变量。点击下方按钮添加。
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
</div>
<button
  class="btn btn-sm btn-outline btn-primary mt-2"
  on:click={addEnvVar}
>
  <i class="fa-solid fa-plus"></i> 添加环境变量
</button>
<div class="mt-3 text-xs opacity-40 space-y-1">
  <p><strong>Host</strong>：仅注入主进程，Sandbox 不可见。适用于敏感密钥、数据库连接等。</p>
  <p><strong>Sandbox</strong>：仅注入沙盒环境，主进程不可见。适用于 Skill 调用的第三方 API Key。</p>
  <p><strong>Both</strong>：同时注入主进程和沙盒。适用于共享配置（如 Tavily API Key）。</p>
</div>
