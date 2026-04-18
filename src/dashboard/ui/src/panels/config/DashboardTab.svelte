<script>
  export let config;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-gauge-high opacity-50 mr-1"></i> Dashboard
  <span class="restart-hint"
    ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
  >
</h3>
<p class="text-xs opacity-50 mb-3">
  监听地址、端口与访问 token。默认仅本机；公网请谨慎并务必设置强 token。
</p>
<div class="cfg-grid-3">
  <label class="cfg-check"
    ><input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.dashboard.enabled}
    /><span>启用</span></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">主机名 / IP</span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.dashboard.host}
      placeholder="127.0.0.1"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">端口</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.dashboard.port}
      placeholder="6767"
    /></label
  >
</div>
<label class="cfg-field mt-2"
  ><span class="cfg-label">Token</span>
  <input
    type="password"
    class="input input-xs input-bordered w-full"
    bind:value={config.dashboard.token}
    on:focus={pwFocus}
    on:blur={pwBlur}
  /></label
>
