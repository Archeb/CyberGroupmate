<script>
  export let config;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-clock opacity-50 mr-1"></i> 全局时区
</h3>
<p class="text-xs opacity-50 mb-3">
  影响 prompt 中的时间显示和作息判断。使用 IANA 标识符。
</p>
<input
  type="text"
  class="input input-sm input-bordered w-full max-w-xs"
  bind:value={config.timezone}
  placeholder="Asia/Shanghai"
  list="tz-list"
/>
<datalist id="tz-list">
  <option value="Asia/Shanghai"></option><option value="Asia/Tokyo"
  ></option><option value="America/New_York"></option>
  <option value="America/Los_Angeles"></option><option
    value="Europe/London"
  ></option><option value="UTC"></option>
</datalist>
