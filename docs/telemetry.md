# CyberGroupmate Telemetry & Node Exporter 设计文档

> **文档状态**: 已实现 ✅（2026-03-31）  
> **创建日期**: 2026-03-31  
> **关联架构**: `architecture_v2.md`  
> **实现目标**: 生产级 Prometheus 兼容指标端点，用于群聊质量、LLM 推理 SLA、Token 用量的可观测性  
> **测试状态**: 46/46 测试通过（`tests/metrics.test.ts` 21 + `tests/metrics-prometheus.test.ts` 25）

---

## 1. 设计目标与原则

### 1.1 核心目标

为 CyberGroupmate 聊天 Agent 提供 **Prometheus-compatible** 的可观测性端点，覆盖：

1. **LLM Token 用量** — 按模型（model）和调用方（caller）双维度分解，支持费用估算
2. **LLM 推理 SLA** — 请求延迟（latency）、TPS（Tokens Per Second）、错误率、重试率
3. **群聊数量与互动质量** — 活跃群组数、消息量、attend 次数与决策分布
4. **系统健康指标** — 进程内存、沙盒池状态、队列积压

### 1.2 设计原则

| 原则 | 实现方式 |
|:--- |:--- |
| **安全第一** | 默认仅绑定 `127.0.0.1`，需显式配置才能对外暴露 |
| **零侵入** | 通过现有 `llmEvents` EventEmitter 订阅，不修改 LLM 调用核心路径 |
| **轻量** | 自实现 Prometheus 文本格式渲染，无外部 `prom-client` 依赖 |
| **Pull 模式** | 标准 Prometheus scrape 模式（`GET /metrics`），兼容 Grafana Agent / Prometheus |
| **幂等 scrape** | Gauge 每次 scrape 时实时读取快照，Counter 累计不重置 |

---

## 2. 安全模型

### 2.1 默认 Localhost-Only 绑定

```yaml
# config.yaml (默认值，开箱即用)
metrics:
  enabled: true
  host: "127.0.0.1"   # ⚠️ 仅对本机可见。切勿改为 0.0.0.0 除非你完全了解风险。
  port: 9091
  path: "/metrics"
```

> **警告**：`metrics` 端点不包含身份认证，任何能访问该端口的进程都可读取全量内部状态。  
> 若需远端 Prometheus 抓取，**推荐**使用反向代理（nginx/Caddy）并加 IP allowlist 或 basic auth，而非直接将 `host` 改为 `0.0.0.0`。

### 2.2 暴露公网的正确姿势

```nginx
# 仅允许 Prometheus 服务器 IP 抓取
location /metrics {
    allow 10.0.0.100;  # Prometheus server IP
    deny all;
    proxy_pass http://127.0.0.1:9091/metrics;
}
```

---

## 3. Metric 指标设计

所有指标以 `cybergroupmate_` 为前缀，遵循 [Prometheus 命名规范](https://prometheus.io/docs/practices/naming/)。

### 3.1 LLM Token 用量（Counters）

Token 用量按 **model × caller × provider** 三维 label 分解，支持灵活聚合。

`caller` 值来自 `callLLM(options.caller)` 参数，对应系统内各调用组件：

| caller 值 | 对应组件 |
|:--- |:--- |
| `main_agent` | 主 Agent 决策（PERCEIVE/DECIDE 阶段） |
| `code_act` | CodeActExecutor 多轮交互 |
| `fast_path` | FastPathHandler 快回复 |
| `recording_cluster` | RecordingPipeline 话题聚类 |
| `recording_triage` | RecordingPipeline triage 决策 |
| `reflection` | Reflection 反思引擎 |
| `vision` | Vision 辅助 LLM（图片描述） |
| `context_compact` | ContextManager 历史压缩 |
| `unknown` | 未指定 caller |

```prometheus
# HELP cybergroupmate_llm_tokens_prompt_total 累计 prompt (input) token 数
# TYPE cybergroupmate_llm_tokens_prompt_total counter
cybergroupmate_llm_tokens_prompt_total{model="claude-3-5-sonnet-20241022",caller="main_agent",provider="anthropic"} 142350

# HELP cybergroupmate_llm_tokens_completion_total 累计 completion (output) token 数
# TYPE cybergroupmate_llm_tokens_completion_total counter
cybergroupmate_llm_tokens_completion_total{model="claude-3-5-sonnet-20241022",caller="main_agent",provider="anthropic"} 8920

# HELP cybergroupmate_llm_tokens_cached_total 累计 cache 命中 token 数（prompt 中被缓存命中的部分）
# TYPE cybergroupmate_llm_tokens_cached_total counter
cybergroupmate_llm_tokens_cached_total{model="claude-3-5-sonnet-20241022",caller="main_agent",provider="anthropic"} 103000

# HELP cybergroupmate_llm_tokens_cache_creation_total 累计 cache 写入 token 数（Anthropic prompt caching）
# TYPE cybergroupmate_llm_tokens_cache_creation_total counter
cybergroupmate_llm_tokens_cache_creation_total{model="claude-3-5-sonnet-20241022",caller="main_agent",provider="anthropic"} 12800
```

**用量仪表板查询示例（PromQL）：**

```promql
# 各 caller 每小时 token 消耗速率
rate(cybergroupmate_llm_tokens_prompt_total[1h])

# 缓存命中率（越高越省钱）
sum(rate(cybergroupmate_llm_tokens_cached_total[1h])) /
sum(rate(cybergroupmate_llm_tokens_prompt_total[1h]))

# 按模型聚合的 output token 总量
sum by (model) (cybergroupmate_llm_tokens_completion_total)
```

---

### 3.2 LLM 推理 SLA

#### 3.2.1 请求延迟（Latency）

```prometheus
# HELP cybergroupmate_llm_request_duration_ms LLM 请求端到端耗时（毫秒）
# TYPE cybergroupmate_llm_request_duration_ms histogram
cybergroupmate_llm_request_duration_ms_bucket{model="claude-3-5-sonnet-20241022",caller="main_agent",provider="anthropic",status="success",le="500"} 2
cybergroupmate_llm_request_duration_ms_bucket{...,le="1000"} 15
cybergroupmate_llm_request_duration_ms_bucket{...,le="2000"} 48
cybergroupmate_llm_request_duration_ms_bucket{...,le="5000"} 112
cybergroupmate_llm_request_duration_ms_bucket{...,le="10000"} 145
cybergroupmate_llm_request_duration_ms_bucket{...,le="30000"} 158
cybergroupmate_llm_request_duration_ms_bucket{...,le="60000"} 160
cybergroupmate_llm_request_duration_ms_bucket{...,le="+Inf"} 162
cybergroupmate_llm_request_duration_ms_sum{...} 489320
cybergroupmate_llm_request_duration_ms_count{...} 162
```

**Buckets 设计**（单位 ms）：`500, 1000, 2000, 5000, 10000, 30000, 60000`

> **TODO（TTFT/ITL 说明）**: 当前三个 Provider（OpenAI、Anthropic、Google）均使用**非流式调用**，无法在 API 层独立测量 TTFT（Time To First Token）和 ITL（Inter-Token Latency）。  
> 当前近似方案：
> - **TTFT ≈ `request_duration_ms`**（端到端总延迟作为 TTFT 上界）  
> - **ITL ≈ `duration_s / completion_tokens`**（推算平均 token 生成时间，即 TPS 倒数）
>
> 待将来切换为流式调用时，应在 `src/core/llm/openai.ts`、`anthropic.ts`、`google.ts` 各 Provider 中新增 `onFirstChunk` / `onChunk` callback hook，从而获取精确 TTFT 和 ITL 序列。

**PromQL 示例：**

```promql
# P95 延迟（全局）
histogram_quantile(0.95, sum(rate(cybergroupmate_llm_request_duration_ms_bucket[5m])) by (le))

# 各模型 P50/P95/P99
histogram_quantile(0.99,
  sum(rate(cybergroupmate_llm_request_duration_ms_bucket[5m])) by (le, model)
)

# 超过 10 秒的慢请求比例
sum(rate(cybergroupmate_llm_request_duration_ms_bucket{le="10000"}[5m]))
  /
sum(rate(cybergroupmate_llm_request_duration_ms_count[5m]))
```

#### 3.2.2 TPS（Tokens Per Second）

```prometheus
# HELP cybergroupmate_llm_tps LLM 每秒生成 token 数（completion_tokens / duration_s，非流式推算值）
# TYPE cybergroupmate_llm_tps histogram
cybergroupmate_llm_tps_bucket{model="claude-3-5-sonnet-20241022",caller="code_act",provider="anthropic",le="5"} 0
cybergroupmate_llm_tps_bucket{...,le="10"} 3
cybergroupmate_llm_tps_bucket{...,le="20"} 28
cybergroupmate_llm_tps_bucket{...,le="50"} 91
cybergroupmate_llm_tps_bucket{...,le="100"} 130
cybergroupmate_llm_tps_bucket{...,le="200"} 145
cybergroupmate_llm_tps_bucket{...,le="+Inf"} 148
cybergroupmate_llm_tps_sum{...} 5920
cybergroupmate_llm_tps_count{...} 148
```

**Buckets 设计**（tokens/s）：`5, 10, 20, 50, 100, 200`

#### 3.2.3 请求计数与重试

```prometheus
# HELP cybergroupmate_llm_requests_total LLM 调用总次数
# TYPE cybergroupmate_llm_requests_total counter
cybergroupmate_llm_requests_total{model="gpt-4o",caller="fast_path",provider="openai",status="success"} 847
cybergroupmate_llm_requests_total{model="gpt-4o",caller="fast_path",provider="openai",status="error"} 12

# HELP cybergroupmate_llm_retries_total LLM 自动重试次数
# TYPE cybergroupmate_llm_retries_total counter
cybergroupmate_llm_retries_total{model="gpt-4o",caller="fast_path",provider="openai",reason="rate_limit"} 8
cybergroupmate_llm_retries_total{...,reason="server_error"} 3
cybergroupmate_llm_retries_total{...,reason="network_error"} 1
cybergroupmate_llm_retries_total{...,reason="user_retry"} 0
```

`reason` label 值来自 `llm.ts` 中的 `reason` 分类：`rate_limit | server_error | network_error | empty_response | user_retry`

---

### 3.3 群聊统计

#### 3.3.1 群聊数量与状态

```prometheus
# HELP cybergroupmate_groups_total 当前活跃 subagent（群组）总数
# TYPE cybergroupmate_groups_total gauge
cybergroupmate_groups_total 5

# HELP cybergroupmate_group_engagement_score 群组 engagement 分数（0-100）
# TYPE cybergroupmate_group_engagement_score gauge
cybergroupmate_group_engagement_score{chat_id="-1001234567890"} 72

# HELP cybergroupmate_group_buffer_size Observer Q2 buffer 中未处理消息数
# TYPE cybergroupmate_group_buffer_size gauge
cybergroupmate_group_buffer_size{chat_id="-1001234567890"} 14

# HELP cybergroupmate_group_codeact_queue_size CodeActExecutor Q4 待执行任务数
# TYPE cybergroupmate_group_codeact_queue_size gauge
cybergroupmate_group_codeact_queue_size{chat_id="-1001234567890"} 1

# HELP cybergroupmate_group_last_attend_age_seconds 距上次 attend 的时间（秒）
# TYPE cybergroupmate_group_last_attend_age_seconds gauge
cybergroupmate_group_last_attend_age_seconds{chat_id="-1001234567890"} 127

# HELP cybergroupmate_group_stickiness 群组亲密度等级指示器（值为 1 表示当前等级）
# TYPE cybergroupmate_group_stickiness gauge
cybergroupmate_group_stickiness{chat_id="-1001234567890",level="FAMILIAR"} 1
cybergroupmate_group_stickiness{chat_id="-1001234567890",level="CORE"} 0
```

#### 3.3.2 群聊消息量与 Attend 统计

```prometheus
# HELP cybergroupmate_group_messages_total 各群组接收消息总量（自启动以来）
# TYPE cybergroupmate_group_messages_total counter
cybergroupmate_group_messages_total{chat_id="-1001234567890"} 3241

# HELP cybergroupmate_group_attends_total 主 Agent attend 并做出决策的总次数
# TYPE cybergroupmate_group_attends_total counter
cybergroupmate_group_attends_total{chat_id="-1001234567890",decision="REPLY"} 128
cybergroupmate_group_attends_total{chat_id="-1001234567890",decision="DEFER"} 43
cybergroupmate_group_attends_total{chat_id="-1001234567890",decision="OBSERVE"} 17
cybergroupmate_group_attends_total{chat_id="-1001234567890",decision="FAST_PATH_AUTH"} 22

# HELP cybergroupmate_group_fast_path_replies_total FastPath 快回覆发送次数
# TYPE cybergroupmate_group_fast_path_replies_total counter
cybergroupmate_group_fast_path_replies_total{chat_id="-1001234567890"} 67
```

`decision` 对应主 Agent Phase 6 的分派决策类型。

#### 3.3.3 话题统计

```prometheus
# HELP cybergroupmate_group_topic_count TopicRegistry 中各状态话题数量
# TYPE cybergroupmate_group_topic_count gauge
cybergroupmate_group_topic_count{chat_id="-1001234567890",state="OPEN"} 2
cybergroupmate_group_topic_count{chat_id="-1001234567890",state="SEALED"} 1
cybergroupmate_group_topic_count{chat_id="-1001234567890",state="STALE"} 0
cybergroupmate_group_topic_count{chat_id="-1001234567890",state="ARCHIVED"} 14
```

---

### 3.4 系统与队列指标

```prometheus
# HELP cybergroupmate_main_loop_ticks_total 主 Agent event loop 总 tick 次数
# TYPE cybergroupmate_main_loop_ticks_total gauge
# 注：实现中为 Gauge（scrape 时实时读取 mainLoop.getTickCount()），而非 Counter。
# Prometheus rate() 不适用；使用 increase() 或直接差值查询。
cybergroupmate_main_loop_ticks_total 4821

# HELP cybergroupmate_main_loop_running 主 Agent event loop 是否运行中（1=运行，0=停止）
# TYPE cybergroupmate_main_loop_running gauge
cybergroupmate_main_loop_running 1

# HELP cybergroupmate_q3_queue_size 注意力队列（Q3）当前待处理群组数
# TYPE cybergroupmate_q3_queue_size gauge
cybergroupmate_q3_queue_size 3

# HELP cybergroupmate_q5_callback_pending 回调队列（Q5）待处理回调数
# TYPE cybergroupmate_q5_callback_pending gauge
cybergroupmate_q5_callback_pending 1

# HELP cybergroupmate_sandbox_pool_active SandboxPool 当前使用中的沙盒数
# TYPE cybergroupmate_sandbox_pool_active gauge
cybergroupmate_sandbox_pool_active 2

# HELP cybergroupmate_sandbox_pool_idle SandboxPool 当前空闲的沙盒数
# TYPE cybergroupmate_sandbox_pool_idle gauge
cybergroupmate_sandbox_pool_idle 1

# HELP cybergroupmate_feedback_loop_windows_active FeedbackLoop 当前活跃追问窗口数
# TYPE cybergroupmate_feedback_loop_windows_active gauge
cybergroupmate_feedback_loop_windows_active 1
```

---

### 3.5 进程级指标

```prometheus
# HELP cybergroupmate_process_uptime_seconds 进程运行时间（秒）
# TYPE cybergroupmate_process_uptime_seconds gauge
cybergroupmate_process_uptime_seconds 86423

# HELP cybergroupmate_process_heap_used_bytes V8 堆内存已使用字节数
# TYPE cybergroupmate_process_heap_used_bytes gauge
cybergroupmate_process_heap_used_bytes 187234304

# HELP cybergroupmate_process_heap_total_bytes V8 堆内存总分配字节数
# TYPE cybergroupmate_process_heap_total_bytes gauge
cybergroupmate_process_heap_total_bytes 234881024

# HELP cybergroupmate_process_rss_bytes 进程 RSS（常驻内存集）字节数
# TYPE cybergroupmate_process_rss_bytes gauge
cybergroupmate_process_rss_bytes 312573952
```

---

## 4. 模块架构

```
src/metrics/
├── index.ts                          # 公共入口：MetricsExporter 工厂 + startMetrics()
├── registry.ts                       # Prometheus 文本格式自实现 + 所有 metric 对象注册
├── exporter.ts                       # HTTP server (node:http, localhost-only)
└── collectors/
    ├── llm-collector.ts              # 订阅 llmEvents，更新 LLM SLA metrics
    ├── group-collector.ts            # scrape 时从 SubagentManager 读取群组快照
    └── system-collector.ts           # process.memoryUsage() + SandboxPool + Q 状态
```

### 4.1 数据流

```mermaid
graph TD
    LLM[callLLM] -->|emit llm:call| LE[llmEvents EventEmitter]
    LLM -->|emit llm:response| LE
    LLM -->|emit llm:retry| LE
    LE -->|订阅| LC[LLMCollector]
    LC -->|更新| REG[MetricsRegistry]

    SM[SubagentManager] -->|scrape时读取| GC[GroupCollector]
    NC[NotificationCenter onPush] -->|消息计数+1| GC
    GC -->|更新| REG

    PP[process.memoryUsage] -->|scrape时读取| SC[SystemCollector]
    SP[SandboxPool.getStats] -->|scrape时读取| SC
    SC -->|更新| REG

    REG -->|render()| EXP[MetricsExporter HTTP :9091/metrics]
    EXP -->|GET /metrics| PROM[Prometheus / Grafana Agent]
```

### 4.2 metric 类型自实现

`registry.ts` 将实现三种 metric 原语（无依赖）：

```typescript
/** Counter: 单调递增，reset() 后清零但通常不调用 */
class Counter {
  private values = new Map<string, number>(); // labelKey → value
  inc(labels: Record<string, string>, delta = 1): void;
  render(name: string, help: string): string; // 输出 Prometheus 文本
}

/** Gauge: 任意方向变化的瞬时值 */
class Gauge {
  private values = new Map<string, number>();
  set(labels: Record<string, string>, value: number): void;
  render(name: string, help: string): string;
}

/** Histogram: 分桶分布统计 */
class Histogram {
  private buckets: number[];        // bucket upper bounds
  private counts = new Map<...>();  // per-labelKey per-bucket
  private sums = new Map<...>();
  private totals = new Map<...>();
  observe(labels: Record<string, string>, value: number): void;
  render(name: string, help: string): string;
}
```

---

## 5. 配置参考

```yaml
# config.yaml

metrics:
  # 是否启用 metrics exporter
  enabled: true

  # ⚠️ 绑定地址 —— 默认且强烈推荐保持 127.0.0.1（仅本机可访问）
  # 若需要远端 Prometheus 抓取，请使用反向代理并加 IP allowlist，
  # 不要直接改为 0.0.0.0，除非你清楚了解安全风险。
  host: "127.0.0.1"

  # Prometheus scrape 端口（9091 是 Node Exporter 常用备用端口）
  port: 9091

  # scrape 路径（通常不需要修改）
  path: "/metrics"
```

---

## 6. 集成 Prometheus & Grafana

### 6.1 Prometheus scrape 配置

```yaml
# prometheus.yml
scrape_configs:
  - job_name: cybergroupmate
    scrape_interval: 15s
    static_configs:
      - targets: ['127.0.0.1:9091']
    # 若通过反向代理暴露到远端：
    # - targets: ['your-server:9091']
    # basic_auth:
    #   username: prometheus
    #   password: secret
```

### 6.2 推荐 Grafana 面板结构

| 面板 | 查询 | 可视化类型 |
|:--- |:--- |:--- |
| LLM 请求速率（by caller） | `sum by (caller) (rate(cybergroupmate_llm_requests_total[5m]))` | Time series |
| Token 消耗速率（by model） | `sum by (model) (rate(cybergroupmate_llm_tokens_completion_total[5m]))` | Time series |
| 缓存命中率 | `sum(rate(cybergroupmate_llm_tokens_cached_total[5m])) / sum(rate(cybergroupmate_llm_tokens_prompt_total[5m]))` | Stat |
| LLM P95 延迟（by model） | `histogram_quantile(0.95, sum by (le,model) (rate(cybergroupmate_llm_request_duration_ms_bucket[5m])))` | Time series |
| LLM 平均 TPS（by model） | `histogram_quantile(0.5, sum by (le,model) (rate(cybergroupmate_llm_tps_bucket[5m])))` | Stat |
| 错误率 | `rate(cybergroupmate_llm_requests_total{status="error"}[5m])` | Time series |
| 群组 Engagement 热图 | `cybergroupmate_group_engagement_score` | Heatmap |
| Attend 决策分布 | `sum by (decision) (cybergroupmate_group_attends_total)` | Pie chart |
| 队列积压 | `cybergroupmate_q3_queue_size`, `cybergroupmate_q5_callback_pending` | Stat |
| 进程内存 | `cybergroupmate_process_heap_used_bytes` | Time series |

### 6.3 Grafana Agent 配置（推荐，用于远端场景）

```yaml
# agent.yml（运行在 CyberGroupmate 同机）
metrics:
  configs:
    - name: cybergroupmate
      scrape_configs:
        - job_name: cybergroupmate
          static_configs:
            - targets: ['127.0.0.1:9091']
      remote_write:
        - url: https://your-grafana-cloud/prometheus/push
          basic_auth:
            username: your_id
            password: your_key
```

---

## 7. 实现说明（Known Limitations）

### 7.1 TTFT / ITL 当前近似方案

> **当前状态（非流式）**：TTFT = 端到端 `request_duration_ms`，ITL 通过 `completion_tokens / duration_s` 倒推 TPS。

当前所有三个 Provider（`openai.ts`、`anthropic.ts`、`google.ts`）均使用非流式调用，等待 API 返回完整响应后才 resolve。因此：

- **TTFT**（Time To First Token）无法精确测量，以端到端 latency 作为上界近似值
- **ITL**（Inter-Token Latency）无法测量单个 token 间隔，通过 TPS（= `completion_tokens / duration_s`）推算平均值

**未来改进（TODO）**：切换为流式调用时，在各 Provider 内部：
1. 记录 `firstChunkAt = Date.now()` — 收到第一个 chunk 时
2. 记录 `chunkTimestamps[]` — 每个 chunk 到达时间
3. 通过 `llmEvents.emit("llm:stream_chunk", {...})` 事件传递给 LLMCollector
4. LLMCollector 新增 `llm_ttft_ms` Histogram 和 `llm_itl_ms` Histogram

### 7.2 Label Cardinality 控制

`chat_id` label 可能引入较高 cardinality（每群一个时序）。建议：
- 群组数 < 100 时无需担心
- 群组数 > 1000 时考虑将 `chat_id` 替换为 `stickiness_level` 等低 cardinality 聚合维度

### 7.3 Counter 持久化

当前 Counter 存在内存中，进程重启后重置为 0，Prometheus 会检测到 counter reset 并正确处理（`rate()` 函数自动适配）。若需要跨重启持久化，可定期将 counter snapshot 写入 `workspace/metrics-state.json`（类似 `token-stats.json` 的实现）。

---

## 8. Prometheus Scrape 兼容性测试

> **测试文件**: `tests/metrics-prometheus.test.ts` — 46/46 个测试用例  
> **目的**: 内嵌 Prometheus 文本格式解析器，模拟 Prometheus scraper 的完整抓取行为，验证数值准确性和格式合规性

### 8.1 PrometheusTextParser（内嵌解析器）

测试文件内实现了一个完整的 Prometheus 文本格式解析器，解析 `/metrics` HTTP 响应并结构化为 `Map<名称, MetricFamily>`，可按 metric 名称、label 集合精确查询任意 sample 的数值。解析逻辑覆盖：

- `# HELP` / `# TYPE` 元数据行
- 带 label 的 sample（`metric{k="v"} val`）和无 label 的 sample（`metric val`）
- Histogram 三元组：`_bucket{le=...}` / `_sum` / `_count` 自动归属到基础 metric family  
  - 仅当 `# TYPE xxx histogram` 已出现时才执行 suffix 剥离，避免误剥真实 `*_count` metric 名称（如 `group_topic_count`）
- 字符串转义：`\"` → `"`, `\n` → 换行, `\\` → `\`
- `+Inf` 作为 label value（如 `le="+Inf"`）与作为 metric 数值的区分处理

### 8.2 测试覆盖矩阵

| 测试组 | 用例数 | 主要验证点 |
|:--- |:--- |:--- |
| **A. Parser 自测** | 6 | HELP/TYPE 解析、labeled/plain sample、histogram 三元组、`\"` 转义、空行注释忽略、`le="+Inf"` label 解析 |
| **B. Counter E2E 数据流** | 2 | onMessage/onAttend/onFastPathReply 计数写入后 HTTP scrape 验证数值；单调递增性（每次 +1） |
| **C. Histogram 精确性** | 2 | LLM duration buckets 累计值验证（300ms→≤500, 1500ms→≤2000, 8000ms→≤10000）；`_sum=9800`、`_count=3`、`+Inf=3`；TPS histogram 同理 |
| **D. Gauge 数据流** | 2 | SystemCollector mock deps（sandbox=3, q3=5, q5=2, ticks=9999, loop=1, fb=4）全部出现在 scrape；Gauge 覆写性（同一指标第二次 scrape 更新为新值） |
| **E. GroupCollector 全属性** | 2 | stickiness CORE=1/FAMILIAR=0 指示器；OPEN/SEALED/ARCHIVED topic 计数；last attend age ~120s（±5s 容差）；多群组engagemnt独立报告 |
| **F. Label 格式** | 3 | `"` 转义正确 render、labels 按字母序排序、多 label 集合 histogram 产出独立 series（不同 model 标签） |
| **G. 全量 metric 完整性** | 3 | 所有 29 个 `cybergroupmate_*` family 均出现；每个 family 有非空 HELP 和 TYPE≠untyped；body 以 `\n` 结尾 |
| **H. 安全性** | 3 | 默认 `127.0.0.1`；自定义 `/custom-metrics` path 生效；query string 被剥离（`?format=openmetrics` 不影响匹配） |
| **I. 幂等性与稳定性** | 2 | Gauge 三次连续 scrape 数值稳定；Counter 5轮 scrape 单调递增且最终等于 5 |

### 8.3 关键设计决策

**`group_topic_count` 解析问题**：该 metric 名称以 `_count` 结尾，朴素的 suffix 剥离算法会错误地将其归属到不存在的 `group_topic` family，导致 HELP 行丢失。修复方案：仅当 `# TYPE xxx histogram` 已在 HELP/TYPE 块中声明时才剥离对应 suffix，否则保留原名。

**`le="+Inf"` 的处理**：`+Inf` 出现在 label value 中时（`{le="+Inf"}`），metric 数值仍为整数（如 `100`）；仅当 metric 值本身为 `+Inf` 字符串时才解析为 `Infinity`。两者不能混淆。

**测试端口隔离**：所有 HTTP 测试使用 `19200-19215` 端口范围，避免与业务默认端口 `9091` 冲突，且每个测试用例使用独立端口防止 `EADDRINUSE`。
