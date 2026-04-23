## Why

当前项目工作流已经进入多阶段、跨服务编排状态，但缺少统一的全局性能观测视图。现有 Trigger 节点级观测不足以回答“某个会话为什么慢”“首消息耗时卡在哪一段”“哪类 run 在 P95 上最差”这类核心问题，也无法稳定回答“这个 case 拆成了多少个 scene”“哪些 scene 预期是 `motion-only`、哪些预期走图片”“最终没用图是因为超时、无候选、guardrail 拒绝还是下载失败”。因此在继续做性能优化前，必须先补齐可落地的 tracing、workflow 级观测和单 case 诊断能力。

## What Changes

- 引入基于 OpenTelemetry 的统一 tracing 方案，覆盖 Next.js API、后台 workflow、外部依赖调用与关键渲染阶段。
- 采用 Dash0 作为 traces、logs、metrics 的统一观测后端，并建立本项目的服务、环境与 workflow 维度约定。
- 为项目会话工作流增加自定义 `workflow_events` / `workflow_spans` 业务事件层，记录 `projectId`、`turnId`、`runId`、`phase`、`step`、`durationMs`、`status`、`attempt` 等字段。
- 建立跨 Vercel、Trigger 与应用代码的 trace correlation 方案，使单个请求、单个 run 和单个会话可被串成同一条可追踪链路。
- 为 UI 或内部运营页面提供全局 workflow timeline / 阶段明细视图，能查看总耗时、阶段拆分、失败位置、重试次数和关键 KPI。
- 为 UI 或内部运营页面提供单个 `runId` 级别的 case diagnostics 视图，能查看 storyboard scene 拆分、每个 scene 的预期 visual mode、scene asset search/materialize 结果、最终 render 消费结果与失败原因。
- 统一定义关键性能指标，包括 `user message -> first visible feedback`、`bootstrap`、`research`、`goal`、`script`、`tts`、`storyboard`、`scene asset search`、`render preview`、`upload artifacts` 等阶段耗时。
- 为关键路径补齐结构化日志、span attributes、错误标签、reason code 与采样策略，确保性能问题与失败问题能在 Dash0、timeline 与单 case 诊断视图中同时定位。
- 明确 observability rollout、数据保留、采样开关、成本控制与回滚策略，避免 tracing 本身反向拖慢主流程。

## Capabilities

### New Capabilities
- `workflow-observability-and-tracing`: 定义项目工作流的 OpenTelemetry 埋点、Dash0 集成、workflow 业务事件模型、全局 timeline 视图和关键性能指标约束。

### Modified Capabilities
- 无

## Impact

- 影响代码：
  - `src/app/api/projects/[projectId]/messages/route.ts`
  - `src/lib/data/project-conversations-repository.ts`
  - `trigger/workspace/goalToStoryboard.ts`
  - `src/lib/workspace/*` 中对 Tavily、Firecrawl、Remotion、scene search、preview 相关调用
  - `instrumentation.ts` / `instrumentation.node.ts` 或等价 OTel 初始化入口
  - 会话详情页或内部运营页的 timeline / metrics / case diagnostics 展示代码
- 影响数据与基础设施：
  - Dash0 项目与 ingest 配置
  - OpenTelemetry SDK、exporter、resource attributes、sampling 配置
  - 应用侧 `workflow_events` / `workflow_spans` 表或等价存储
  - scene-level workflow diagnostics 元数据或等价存储
  - Vercel 与 Trigger 的 trace/log correlation 约定
- 风险：
  - tracing 与日志采集会引入额外开销，需控制采样率、字段体积与写入频率
  - 若仅依赖基础设施 traces 而缺少业务事件层，仍无法回答会话级、run 级和 scene 级的性能问题
