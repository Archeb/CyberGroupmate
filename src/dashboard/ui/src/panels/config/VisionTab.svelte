<script>
  export let config;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-eye opacity-50 mr-1"></i> Vision
</h3>
<p class="text-xs opacity-50 mb-3">
  图片和贴纸的处理行为。需配合 vision 路由使用。
</p>
<div class="cfg-grid-2">
  <label class="cfg-field"
    ><span class="cfg-label">Attend 媒体策略</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.vision.attendMode}
    >
      <option value={undefined}>默认 (disable)</option>
      <option value="disable">disable（禁用媒体富化）</option>
      <option value="describe">describe（仅文字描述）</option>
      <option value="vision">vision（看图 + 内联图片）</option>
    </select></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">压缩阈值 (px)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.vision.maxImageSize}
      placeholder="1024"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">单轮最大图片</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.vision.maxImagesPerContext}
      placeholder="3"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">Sticker 模式</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.vision.stickerMode}
    >
      <option value={undefined}>默认 (emoji_only)</option>
      <option value="emoji_only">emoji_only</option><option
        value="vision_cache">vision_cache</option
      ><option value="vision_each">vision_each</option>
    </select></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">下载上限 (MB)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.vision.maxMediaDownloadSize}
      placeholder="20"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">媒体保留天数</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.vision.mediaRetentionDays}
      placeholder="3"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">Sticker 发送策略</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.vision.stickerSendingMode}
    >
      <option value={undefined}>全部允许（默认）</option>
      <option value="allow_all">allow_all（全部允许）</option>
      <option value="allow_listed">allow_listed（仅指定）</option>
      <option value="disallow_all">disallow_all（全部禁止）</option>
    </select></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">新表情包默认</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.vision.newStickerDefault}
    >
      <option value={undefined}>启用（默认）</option>
      <option value="enabled">enabled（启用）</option>
      <option value="disabled">disabled（禁用）</option>
    </select></label
  >
</div>
