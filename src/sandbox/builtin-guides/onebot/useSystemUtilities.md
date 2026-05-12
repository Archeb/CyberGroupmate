OneBotGuide: useSystemUtilities

本指南用于 OneBot/NapCat 的运行状态、版本探测、发送能力检查、OCR、URL 安全检查、频道资料和 AI 语音等低频工具类能力。

## 执行入口

```ts
const status = await onebot.callApi("get_status", {});
```

`onebot.callApi(action, params)` 是 guide-only 的受控 NapCat passthrough；只允许 allowlist 动作。

## 状态和诊断

- `get_version_info`: 获取 NapCat/OneBot 版本信息。
- `get_status`: 获取运行状态。
- `can_send_image`: 检查是否可以发送图片。
- `can_send_record`: 检查是否可以发送语音。
- `nc_get_packet_status`: 获取 Packet 状态。

## 工具能力

- `ocr_image`: 图片 OCR 识别。
- `translate_en2zh`: 英文单词翻译。
- `check_url_safely`: 检查 URL 安全性。
- `get_guild_list`: 获取频道列表。
- `get_guild_service_profile`: 获取频道个人信息。
- `get_ai_characters`: 获取群 AI 角色列表。
- `get_ai_record`: 获取 AI 语音 URL。
- `send_group_ai_record`: 发送群 AI 语音。

## 不暴露的系统动作

`send_packet`、`bot_exit`、`set_restart`、`clean_cache` 不通过 guide 暴露。它们会影响 NapCat 服务本身或绕开常规 OneBot 语义，不适合给执行 agent 常驻使用。

## 示例

```ts
const canImage = await onebot.callApi("can_send_image", {});
const version = await onebot.callApi("get_version_info", {});

const ocr = await onebot.callApi("ocr_image", {
  image: "https://example.com/image.png",
});
```
