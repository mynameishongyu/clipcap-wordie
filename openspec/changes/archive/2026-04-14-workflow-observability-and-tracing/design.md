## Context

当前项目的执行路径已经跨越 Next.js API、后台 continuation、Trigger workflow、外部搜索/抓取依赖、模型调用、Remotion 渲染与持久化上传等多个系统，但观测数据仍然是割裂的：

- Vercel 侧更偏 request/function 维度
- Trigger 侧更偏 task/run 维度
- 应用侧主要靠零散日志和数据库状态

这导致我们很难回答以下问题：

- 某个 `projectId` / `runId` 为什么慢
- `user message -> first visible feedback` 卡在哪段
- 某类 case 的 `preview ready` P50 / P95 是多少
- 慢是出在 Trigger、外部依赖、模型调用，还是应用编排
- 一个具体 case 最终拆成了多少个 scene
- 每个 scene 原本预期是 `motion-only`、`image`、template 还是 fallback
- 某个 scene 最终没用图片，是因为 intent 路由、judge timeout、无合适候选、下载失败，还是 guardrail 拒绝

本 change 的核心不是只接一个 tracing 产品，而是建立“两层观测模型”：

1. 基础设施层：OpenTelemetry spans + Dash0
2. 业务工作流层：`workflow_events` / `workflow_spans` + 会话级 timeline 视图 + 单 case diagnostics 视图

现状约束：

- 现有主流程已经复杂，新增观测不能显著拖慢关键路径
- 项目运行在 Vercel + Trigger 的混合环境中，trace context 必须能跨边界传播
- 单靠基础设施 trace 不足以表达产品阶段语义，例如 `bootstrap`、`script_pending_confirmation`、`preview_ready`
- observability 的数据模型后续还要支持性能优化和故障定位，因此字段设计必须稳定、可聚合

## Goals / Non-Goals

**Goals:**

- 为 Next.js API、Trigger workflow、外部依赖调用和关键 render 阶段统一引入 OpenTelemetry spans。
- 使用 Dash0 作为 traces、logs、metrics 的统一后端，并约定服务名、环境、版本与 workflow 维度标签。
- 建立自定义 `workflow_events` / `workflow_spans` 业务事件层，记录 run 级和会话级阶段耗时明细。
- 建立单个 `runId` 可诊断的数据模型，记录 storyboard scene 拆分、scene 级 visual 决策、asset search/materialize 结果与最终 render 消费结果。
- 打通 `projectId`、`turnId`、`runId`、`traceId`、`spanId` 的关联，让单个会话可跨系统追踪。
- 提供可落地的全局 workflow timeline / metrics 视图，支持定位首反馈耗时、阶段耗时、失败位置和重试情况。
- 提供单 case diagnostics 视图，支持按 scene 回答“预期是什么”“实际发生了什么”“为什么没用图”“拖尾发生在哪个 scene”。
- 明确采样、保留、写入频率与回滚策略，控制可观测性成本和运行时负担。

**Non-Goals:**

- 不在本 change 中重构业务 workflow 本身，只补齐观测与 tracing。
- 不把 Dash0 当作业务真相来源，业务阶段语义仍以应用侧 `workflow_events` 为准。
- 不在首次上线时构建完整 BI 平台或复杂告警体系，优先完成 tracing、timeline 和核心指标。
- 不要求所有低价值内部函数都创建 span，重点覆盖跨边界、慢节点和用户关键路径。
- 不要求首期做任意自定义查询语言或通用报表系统，优先满足单 run 排障和 case 级诊断。

## Decisions

### 1. 采用“两层观测模型”：OTel 基础设施层 + workflow 业务事件层

决策：

- 基础设施层使用 OpenTelemetry spans，输出到 Dash0。
- 业务层使用 `workflow_events` / `workflow_spans` 表或等价存储，记录产品语义阶段与耗时。
- 两层通过 `traceId`、`spanId`、`projectId`、`turnId`、`runId` 进行关联。

原因：

- 仅有 traces 只能看到技术调用链，无法直接表达 “goal generated”“script pending confirmation”“preview ready” 这类产品阶段。
- 仅有数据库事件又无法做跨服务根因定位，尤其是外部依赖和 Trigger 边界。
- 两层分工可以同时满足研发排障、产品运营分析和单 case 归因。

备选方案：

- 只接 Dash0，不做业务事件表。
  - 放弃原因：无法直接回答会话级耗时和阶段 KPI。
- 只做业务事件表，不做 OTel。
  - 放弃原因：无法追踪跨服务和外部依赖的根因。

### 2. OpenTelemetry 埋点覆盖关键边界，而不是追求全量函数级 span

决策：

- 重点埋点范围包括：
  - `/api/projects/[projectId]/messages`
  - `initialize*` / `continue*` 类工作流入口
  - Trigger workflow 顶层阶段
  - Tavily、Firecrawl、模型调用、scene asset search、Remotion preview、artifact upload
- span 设计优先覆盖：
  - 跨进程/跨服务边界
  - 用户关键路径
  - 当前已知高耗时阶段

原因：

- 全量函数级埋点成本高、噪音大，也会抬高运行时开销。
- 当前目标是性能优化和慢点定位，不需要一开始把所有内部辅助函数都纳入 trace。

备选方案：

- 对所有模块做细粒度自动埋点。
  - 放弃原因：短期投入大，信噪比低。

### 3. Dash0 作为统一后端，但业务视图由应用自身负责聚合

决策：

- Dash0 用于承接 traces、logs、metrics，并用于跨服务 trace 检索与关联。
- 应用自身维护 workflow timeline / 阶段明细视图，直接读取 `workflow_events`。
- 业务页面可以附带 Dash0 trace link，但不把 Dash0 查询结果直接当作 UI 主数据源。

原因：

- Dash0 擅长观测后端与关联检索，但产品所需的会话/阶段视图更适合由应用自己控制字段与展示语义。
- 自建业务视图更容易定义阶段、KPI、聚合口径与权限边界。

备选方案：

- 直接在 Dash0 中解决所有视图需求。
  - 放弃原因：产品语义和数据模型可控性不足，嵌入体验也不理想。

### 4. workflow 业务事件表按“阶段开始/结束”模型设计

决策：

- 为每个关键阶段记录结构化事件，至少包含：
  - `projectId`
  - `turnId`
  - `runId`
  - `phase`
  - `step`
  - `startedAt`
  - `finishedAt`
  - `durationMs`
  - `status`
  - `attempt`
  - `traceId`
  - `spanId`
  - `metadata`
- 关键阶段包括：
  - `request_received`
  - `first_visible_feedback`
  - `bootstrap`
  - `research`
  - `goal`
  - `script`
  - `tts`
  - `storyboard`
  - `scene_asset_search`
  - `render_preview`
  - `artifact_persistence`
- 对 scene-sensitive 阶段，`metadata` 必须支持稳定的 scene-level diagnostics 字段，包括：
  - `sceneCount`
  - `sceneId`
  - `expectedVisualMode`
  - `actualVisualMode`
  - `searchQuery`
  - `candidateCount`
  - `judgeStrategy`
  - `reasonCode`
  - `reasonMessage`
  - `downloadMs`
  - `fileSizeBytes`
  - `contentType`
  - `selectedAssetSource`
  - `finalAssetUsage`

原因：

- 阶段开始/结束模型最容易计算总耗时、阶段耗时、重试次数和失败位置。
- scene-level metadata 让同一套事件模型既能支持 KPI 仪表盘，也能支持单 case 归因和“为什么这个 scene 没有图片”的诊断。

备选方案：

- 只记录单点日志，不记录结构化开始/结束事件。
  - 放弃原因：无法稳定计算 duration 和阶段统计。

### 5. Scene diagnostics SHALL 使用标准 reason code，而不是自由文本日志

决策：

- 为 scene intent、judge、materialize、render fallback 这几类关键决策定义稳定 reason code 枚举。
- 示例 reason code 包括：
  - `intent_motion_only`
  - `intent_template`
  - `judge_skipped_clear_winner`
  - `judge_timeout`
  - `judge_no_selection`
  - `materialize_download_timeout`
  - `materialize_rejected_gif`
  - `materialize_rejected_size`
  - `materialize_rejected_type`
  - `materialize_failed`
  - `render_consumed_local_asset`
  - `render_template_fallback`
  - `render_motion_only`
  - `render_visual_fallback`
- 每个 reason code 可附带 `reasonMessage` 作为面向人类的解释，但视图聚合、过滤与统计必须基于 reason code。

原因：

- 自由文本日志可读但不可稳定聚合，难以支持“最常见失败原因”或“某类 scene 为何未用图”的统计。
- reason code 还能避免后续文案调整影响诊断口径。

备选方案：

- 只保留错误字符串，不做 reason code。
  - 放弃原因：无法稳定支持查询、聚合和视图过滤。

### 6. 使用统一 correlation contract 贯穿 Vercel、Trigger 与应用

决策：

- 每个在线请求和后台 run 都必须保持稳定的关联字段：
  - `projectId`
  - `turnId`
  - `runId`
  - `requestId`
  - `traceId`
- 这些字段同时出现在：
  - OTel span attributes
  - 结构化日志
  - `workflow_events`
  - Trigger metadata（可用时）

原因：

- 没有关联 contract，就无法从单个会话跳到 trace，再从 trace 跳回业务 timeline。
- 一致字段还能降低排障成本和运营查数成本。

### 7. 采样、写入与保留策略必须先设计，再接入生产路径

决策：

- 用户关键路径、失败 case、慢 case 使用高优先级采样。
- 高频内部步骤使用较低采样或仅通过业务事件记录。
- scene-level diagnostics 默认只保留结构化摘要，不直接写入大体积候选 payload 或完整模型输入输出。
- `workflow_events` 保持结构化、低冗余，不把大体积 prompt、全文响应或原始 payload 直接写入事件表。
- Dash0 traces 与 logs 保留策略按环境区分，开发环境更宽松，生产环境受预算约束。

原因：

- 观测系统本身不能成为新的性能或成本问题。
- 结构化事件如果无节制膨胀，会影响数据库写入和查询成本。

备选方案：

- 所有请求、所有 span、所有元数据都全量上报。
  - 放弃原因：成本不可控，也会放大性能负担。

### 8. 首期交付必须包含可读的 timeline 视图和单 case diagnostics 视图，而不是只完成后端埋点

决策：

- 首期至少提供一个内部可用的 workflow timeline / metrics 页面，以及一个可按 `runId` 查看 scene 级诊断的明细视图或展开面板。
- 页面需支持：
  - 按 `projectId` / `runId` 检索
  - 查看总耗时与阶段拆分
  - 查看失败阶段、重试次数、trace link
  - 查看关键 KPI，如首反馈耗时、preview ready 耗时
  - 查看 `sceneCount`、每个 `sceneId` 的预期 visual mode、最终 visual mode、未用图原因与拖尾 scene

原因：

- 没有消费层，埋点很快会失去维护动力。
- 当前团队最缺的是“能快速看见哪里慢、为什么慢、具体哪个 scene 出问题”的界面，而不是更多日志。

## Risks / Trade-offs

- [OTel 埋点范围过大导致运行时开销上升] → Mitigation：先覆盖关键边界和慢节点，逐步扩展。
- [只接入 Dash0 而缺少业务事件层，无法回答产品级问题] → Mitigation：将 `workflow_events` 设为首期必做，而不是后续补充。
- [业务事件字段设计不稳定，后续难以聚合] → Mitigation：先固定 phase/step 枚举和核心字段，再逐步扩展 metadata。
- [scene-level metadata 体积过大，反向拖慢写入与查询] → Mitigation：只保留结构化摘要、reason code 和预算相关字段，不写入完整候选列表与大文本。
- [trace context 在 Vercel、Trigger、后台任务之间传播不完整] → Mitigation：明确统一 correlation contract，并在关键边界补充人工透传。
- [观测数据量和保留成本过高] → Mitigation：按环境和价值分层采样，限制大字段写入。
- [只有后端埋点，没有消费视图，团队难以用起来] → Mitigation：首期同时交付内部 timeline / metrics 页面和 case diagnostics 视图。

## Migration Plan

1. 第一阶段：
   - 引入 OpenTelemetry 初始化与基础 exporter 配置。
   - 打通 Dash0 基础连接、服务名与环境标签。
2. 第二阶段：
   - 在 Next.js API、Trigger workflow 和关键外部依赖调用上补齐 spans。
   - 建立统一 correlation contract。
3. 第三阶段：
   - 建立 `workflow_events` / `workflow_spans` 数据模型与写入工具。
   - 为关键阶段补齐结构化开始/结束事件。
   - 为 scene-sensitive 阶段补齐 scene-level diagnostics 摘要和 reason code。
4. 第四阶段：
   - 实现内部 workflow timeline / metrics 视图。
   - 实现单 case diagnostics 视图。
   - 补充 trace link、阶段耗时、scene-level 归因和 KPI 聚合。
5. 第五阶段：
   - 调整采样、保留、写入频率和告警阈值。
   - 基于真实使用情况收敛字段与埋点粒度。

回滚方案：

- 若 OTel exporter 或 Dash0 配置引发问题，可关闭 exporter，仅保留本地事件层。
- 若业务事件写入导致数据库压力过大，可先关闭部分低价值 phase 的事件写入。
- 若 timeline 视图影响现有页面复杂度，可先以内页或内部工具形式上线。

## Open Questions

- `workflow_events` 应该落在现有数据库中，还是单独放到更适合分析的存储中？
- timeline 视图是直接做进现有 project 页面，还是先做独立的内部运营页面？
- 生产环境的默认 traces 采样率、失败 case 强制采样策略和慢请求阈值应如何设定？
- Trigger metadata 与应用侧 `workflow_events` 之间，哪些字段应双写，哪些字段只保留一份？
- scene-level diagnostics 是直接内嵌在 `workflow_events.metadata` 中，还是拆到独立的 run diagnostics 表更合适？
