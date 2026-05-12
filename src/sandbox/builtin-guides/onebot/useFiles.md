OneBotGuide: useFiles

本指南用于 OneBot/NapCat 的图片、语音、文件 URL、群文件系统、私聊文件和群文件目录等成组能力。普通发图、发文件和下载消息媒体优先使用顶层 `sendMedia`、`sendFile`、`downloadMedia`。

## 执行入口

```ts
const image = await onebot.callApi("get_image", { file: "image_id_or_url" });
```

`onebot.callApi(action, params)` 只开放本指南和其他 OneBot guide 中列出的 allowlist 动作。

## 媒体解析动作

- `get_image`: 获取图片信息，参数可用 `{ file }` 或 `{ file_id }`。
- `get_record`: 获取语音信息并可转换格式，常用 `{ file, out_format: "mp3" }`。
- `get_file`: 获取文件信息及下载路径。
- `get_group_file_url`: 获取群文件下载链接。
- `get_private_file_url`: 获取私聊文件下载链接。

## 群文件系统动作

- `get_group_root_files`: 获取群文件根目录列表。
- `get_group_files_by_folder`: 获取某个群文件夹下的文件和子文件夹。
- `get_group_file_system_info`: 获取群文件系统空间和状态。
- `upload_group_file`: 上传群文件。
- `upload_private_file`: 上传私聊文件。
- `delete_group_file`: 删除群文件。
- `create_group_file_folder`: 创建群文件目录。
- `delete_group_folder`: 删除群文件目录。
- `move_group_file`: 移动群文件。
- `rename_group_file`: 重命名群文件。
- `trans_group_file`: 转存群文件。

## 跨机器部署规则

NapCat 文档里很多字段叫“本地路径”，指的是 NapCat 机器的本地路径，不是 CyberGroupmate 机器的路径。跨设备部署时：

- 读取媒体内容：优先 `onebot.downloadMedia(messageIdOrFileOrUrl)`。
- 发送普通文件到聊天：优先 `onebot.sendFile(chatId, localPath)`，它会按配置转成 base64/data URL。
- `callApi` 的上传类动作优先传 HTTP(S) URL 或 NapCat 自己能访问的路径；不要传 CyberGroupmate 本机路径。
- `get_image` / `get_record` 返回 `url` 或 `base64` 时可以继续使用；只返回 `file` 本地路径时不要假设可读。

## 示例

```ts
const localImage = await onebot.downloadMedia(123456);

const urlInfo = await onebot.callApi("get_group_file_url", {
  group_id: 931351956,
  file_id: "file-id-from-message",
});

const root = await onebot.callApi("get_group_root_files", {
  group_id: 931351956,
});
```
