## 赛博群友

你的赛博群友哦，可以帮你语义搜索聊天记录，上网冲浪，陪你一起聊天、吐槽、发电甚至……？总之，一切皆有可能。

终极目标是——让新来的群友一点都看不出这是赛博群友！

目前只支持 Telegram

## 功能特点

- 对每个群友的记忆
- 图像识别和分析
- 发表情包
- 读空气（智能的对话管理和响应机制）
- 可配置的响应策略
- 消息历史记录搜索、联网搜索，以及更多tool use

## 技术栈

- Node.js
- PostgreSQL + pgvector

## 安装

1. 克隆仓库：

```bash
git clone https://github.com/Archeb/CyberGroupmate.git
cd CyberGroupmate
```

2. 安装依赖：

```bash
npm install
```

3. 配置机器人：

```bash
cp src/config.example.js src/config.js
# 编辑config.js文件，根据需要调整配置
```

## 配置说明

主要配置文件位于`src/config.example.js`，分为三层配置项：

- 基础配置（base）
- 聊天集配置（collections）
- 聊天配置（chats）

请先复制一份为 config.js 然后再编辑。collections/chats 配置可以覆盖基础配置

## 项目结构

```
src/
├── config.js              # 配置文件
├── index.js               # 入口文件
├── types/                 # 类型定义
├── handlers/              # 消息处理器
├── helpers/               # 辅助功能
└── managers/              # 管理器
```

## 群聊效果

| ![image](https://github.com/user-attachments/assets/2910ab4c-7e89-4703-848b-ae649ce14eaf) | ![image](https://github.com/user-attachments/assets/77a27811-5269-42f0-9028-b98bc35f7917) |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |

https://github.com/user-attachments/assets/627ddc6e-7ce5-41e5-9ef3-d1aee0c30c8b

## 许可证

本项目采用 GPLv3 许可证。详见[LICENSE](LICENSE)文件。
