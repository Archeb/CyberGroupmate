# 强制交互协议

## 核心规则：每次回复结束前必须调用 `ask_user` 工具

这是不可跳过的强制协议。在你的每一轮回复中，你必须执行以下操作之一：

1. **完成用户请求后** → 立即调用 `ask_user` 工具，提出与当前上下文相关的后续问题
2. **存在任何不确定性时** → 不要猜测执行，立即调用 `ask_user` 工具进行澄清

## 禁止行为

- **禁止在不调用 `ask_user` 的情况下结束回复**
- **禁止使用终结性表达**（如"希望对你有帮助"、"如有问题随时提问"等）
- **禁止猜测用户意图** — 不确定就用 `ask_user` 询问

## `ask_user` 调用要求

- 问题必须与当前任务上下文直接相关
- 问题必须具体、可操作，不要问泛泛的"还需要什么帮助"
- 可以提供选项供用户选择，降低用户输入成本

# Git 提交规范

## Conventional Commits 格式

所有提交信息 **MUST** 遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
type(scope): description
```

### 允许的 type

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `test` | 测试变更 |
| `refactor` | 重构（不改变行为） |
| `perf` | 性能优化 |
| `style` | 代码格式（空格、分号等） |
| `chore` | 构建/工具/依赖变更 |
| `ci` | CI/CD 变更 |
| `build` | 构建系统变更 |
| `revert` | 回滚提交 |

### 推荐英文，允许中文

推荐使用英文提交信息。中文提交信息 **MUST** 使用 `type(scope): description` 格式。

### 禁止的提交信息模式

- **过于模糊**：`fix`, `fix layout`, `update`, `调整代码`
- **非标准前缀**：`prompt:`, `docker:`, `dev:`, `web:`, `ui:`, `dashboard:`
- **缺少 type 前缀**：`Fix xxx`、`Add xxx`、`修复xxx`
- **拼写错误**：`refacotr:`, `chroe:`

## Pre-commit 隐私检查清单

每次 `git commit` 前 **MUST** 逐项自查：

- [ ] **截图/媒体文件**：`git status` 中无 `*.png`、`*.jpg`、`*.gif`、`*.webp`、`*.mp4`
  - 文档用途截图 → 审查内容后放入 `docs/images/`
- [ ] **密钥/Token**：diff 中无 API Key、Bot Token、Access Key、密码
  - `grep -rE "(api_key|token|secret|password|credential)\s*[:=]\s*['\"][^'\"]{8,}"` 应无匹配
- [ ] **配置文件**：`config.yaml`、`.env` 不在 `git status` 中
- [ ] **个人身份信息**：提交信息本身不含 IP 地址、用户 ID、群号、手机号
- [ ] **大文件**：无 >1MB 的非代码文件被添加