## ADDED Requirements

### Requirement: Workflow tracing SHALL cover the cross-service critical path
系统 MUST 为项目工作流的关键跨服务路径提供统一 tracing，至少覆盖 Next.js API 请求入口、后台 bootstrap/workflow 入口、Trigger workflow 顶层阶段、外部依赖调用和预览渲染关键阶段。Tracing SHALL 能够将单个请求和对应 run 串联为一条可追踪链路。

#### Scenario: 在线请求到后台 workflow 可被串联追踪
- **WHEN** 用户发送一个新的项目对话请求
- **THEN** 系统为该请求创建或延续一条统一 trace
- **THEN** 该 trace 可关联到后续 bootstrap、Trigger workflow 和关键 render 阶段

#### Scenario: 外部依赖调用进入 trace 链路
- **WHEN** workflow 调用 Tavily、Firecrawl、模型服务或 artifact upload 等外部依赖
- **THEN** 系统为这些调用创建可关联到父 workflow 的 spans
- **THEN** 排障时可识别慢点属于内部编排还是外部依赖

### Requirement: Workflow events SHALL provide a business-level timeline
系统 MUST 记录结构化 `workflow_events` 或等价业务事件，以表达会话级和 run 级的阶段语义。事件 SHALL 至少包含 `projectId`、`turnId`、`runId`、`phase`、`step`、`startedAt`、`finishedAt`、`durationMs`、`status` 和 `attempt`。

#### Scenario: 关键阶段产生可计算时长的业务事件
- **WHEN** workflow 进入或结束 `bootstrap`、`research`、`goal`、`script`、`tts`、`storyboard`、`render_preview` 等关键阶段
- **THEN** 系统记录结构化开始/结束事件或等价完整事件
- **THEN** 后续可以稳定计算阶段耗时与总耗时

#### Scenario: 失败与重试可在业务事件层定位
- **WHEN** 某个关键阶段失败或发生重试
- **THEN** 业务事件中记录对应的 `status`、`attempt` 和相关元数据
- **THEN** 用户或运营可以直接看出失败阶段和重试次数

### Requirement: Scene-sensitive workflow stages SHALL expose per-scene diagnostics
系统 MUST 为 `storyboard`、`scene_asset_search`、`render_preview` 和相关 fallback 阶段提供 scene 级结构化诊断信息。诊断信息 SHALL 至少能够回答单个 `runId` 中拆分了多少个 scene、每个 scene 预期 visual mode 是什么、最终是否用了本地图片，以及未用图的原因。

#### Scenario: 单个 run 可查看 scene 拆分与预期 visual mode
- **WHEN** 内部用户查看一个具体 `runId` 的 diagnostics
- **THEN** 系统展示该 run 的 `sceneCount`
- **THEN** 系统展示每个 `sceneId` 的预期 visual mode，例如 `motion-only`、`image`、template 或 fallback

#### Scenario: 单个 scene 可查看未用图原因
- **WHEN** 某个 scene 最终没有消费本地图片资产
- **THEN** 系统展示该 scene 未用图的结构化原因
- **THEN** 原因至少可区分 intent 路由、judge timeout、无合适候选、materialize 下载失败、guardrail 拒绝和 render fallback

### Requirement: Scene diagnostics SHALL use stable reason codes
系统 MUST 为 scene 级关键决策和失败原因记录稳定的 reason code，而不是只记录自由文本日志。reason code SHALL 可用于过滤、聚合和统计，并可附带面向人的 `reasonMessage`。

#### Scenario: Materialize 被 guardrail 拒绝时记录稳定 code
- **WHEN** 某个候选资源因为 GIF、大小超限或类型不支持而被拒绝
- **THEN** 系统记录稳定的 reason code，例如 `materialize_rejected_gif`、`materialize_rejected_size` 或 `materialize_rejected_type`
- **THEN** 诊断视图可基于这些 code 直接统计最常见拒绝原因

#### Scenario: Judge 或 render fallback 记录稳定 code
- **WHEN** 某个 scene 因 judge timeout 或 render fallback 未使用图片
- **THEN** 系统记录稳定的 reason code，例如 `judge_timeout`、`render_template_fallback` 或 `render_visual_fallback`
- **THEN** 诊断视图可区分“搜索到了但没选中”和“选中了但最终没渲染”的不同路径

### Requirement: Correlation identifiers SHALL be consistent across traces, logs, and workflow events
系统 MUST 在 traces、结构化日志和业务事件中统一使用可关联字段，至少包括 `projectId`、`turnId`、`runId` 和 `traceId`。关键边界还 MUST 支持将 `spanId` 或等价 trace link 回写到业务事件或可展示视图中。

#### Scenario: 单个 run 可以从业务视图跳转到 trace
- **WHEN** 用户或开发者在 workflow timeline 中查看某个 `runId`
- **THEN** 系统可以通过 `traceId` 或 trace link 跳转到对应 trace
- **THEN** timeline 中的阶段与 trace 中的技术调用链可以相互对照

#### Scenario: 结构化日志可按业务字段检索
- **WHEN** 开发者按 `projectId`、`turnId` 或 `runId` 检索日志
- **THEN** 系统返回的日志与 trace、业务事件使用同一组关联字段
- **THEN** 排障时不需要依赖模糊文本搜索来人工拼接上下文

### Requirement: Dash0 SHALL be the unified backend for traces, logs, and metrics
系统 MUST 使用 Dash0 作为 traces、logs、metrics 的统一观测后端，并为服务名、环境、版本和 workflow 相关资源标签建立稳定约定。不同部署环境 SHALL 可在 Dash0 中清晰区分。

#### Scenario: 不同环境的观测数据可区分
- **WHEN** 开发、预发或生产环境上报 traces 与 logs
- **THEN** Dash0 中能够基于环境标签清晰过滤不同环境的数据
- **THEN** 不同环境的数据不会混淆在同一检索视图中

#### Scenario: 不同服务边界具有稳定资源属性
- **WHEN** API、后台任务与 Trigger workflow 上报观测数据
- **THEN** 这些数据包含稳定的服务名和资源属性约定
- **THEN** Dash0 中可以按服务或阶段聚合查询

### Requirement: The system SHALL expose workflow timeline and KPI views
系统 MUST 提供内部可用的 workflow timeline 或等价明细视图，用于展示单个项目会话或 run 的总耗时、阶段拆分、失败位置、重试次数和关键性能指标。关键性能指标 SHALL 至少包括 `user message -> first visible feedback` 和 `preview ready` 两项。

#### Scenario: 单个 run 展示阶段明细
- **WHEN** 内部用户查看一个具体 `runId`
- **THEN** 系统展示该 run 的总耗时、阶段耗时、失败位置和重试次数
- **THEN** 每个阶段都可看到对应状态和时间范围

#### Scenario: 关键 KPI 可按统一口径展示
- **WHEN** 内部用户查看 workflow metrics 视图
- **THEN** 系统按统一口径展示首反馈耗时、bootstrap 耗时、preview ready 耗时等关键指标
- **THEN** 这些指标的计算来源与 `workflow_events` 一致

#### Scenario: 单 case diagnostics 视图展示 scene-level 归因
- **WHEN** 内部用户按 `runId` 打开单 case diagnostics 视图
- **THEN** 系统展示该 run 的 scene 拆分、各 scene 的预期/实际 visual mode、scene asset search/materialize 结果和最终 render 消费结果
- **THEN** 用户可直接看出拖尾 scene、失败 scene 与未用图原因

### Requirement: Observability collection SHALL be cost-aware and performance-safe
系统 MUST 为 tracing、日志和业务事件写入定义采样、保留和字段体积控制策略，避免观测能力本身显著拖慢工作流或导致不可控成本。系统 MUST NOT 将大体积 prompt、完整响应正文或无上限 metadata 直接写入事件模型。

#### Scenario: 低价值高频事件受采样或简化控制
- **WHEN** 某类内部步骤调用频率高但诊断价值低
- **THEN** 系统对其采用较低采样率、较少字段或仅记录业务事件摘要
- **THEN** 观测数据量不会因为低价值高频事件失控

#### Scenario: 失败和慢请求优先保留
- **WHEN** 某个请求失败或关键阶段超过慢请求阈值
- **THEN** 系统优先保留对应 trace、日志和业务事件
- **THEN** 失败与慢 case 不会因为通用采样策略而丢失核心上下文
