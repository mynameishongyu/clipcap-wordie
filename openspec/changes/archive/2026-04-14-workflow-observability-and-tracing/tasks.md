## 1. OTel 与 Dash0 基础接入

- [x] 1.1 为 Next.js 应用补齐 OpenTelemetry 初始化入口与基础 exporter 配置
- [x] 1.2 配置 Dash0 所需的服务名、环境、版本和资源属性约定
- [x] 1.3 为 Trigger workflow 运行环境补齐与应用一致的 tracing 初始化和资源标签
- [x] 1.4 定义并验证开发、预发、生产环境的 observability 配置开关与安全默认值

## 2. 关键路径 tracing 埋点

- [x] 2.1 在 `/api/projects/[projectId]/messages` 与相关工作流入口补齐关键请求 spans
- [x] 2.2 为 bootstrap、research、goal、script、tts、storyboard、scene asset search、render preview、artifact upload 等关键阶段补齐 spans
- [x] 2.3 为 Tavily、Firecrawl、模型调用和存储上传等外部依赖调用补齐可关联父 span 的 tracing
- [x] 2.4 补齐 `projectId`、`turnId`、`runId`、`requestId`、`traceId` 等 correlation 字段在 spans 与结构化日志中的透传

## 3. Workflow 业务事件层

- [x] 3.1 设计 `workflow_events` / `workflow_spans` 数据模型与 phase/step 枚举
- [x] 3.2 实现统一的业务事件写入工具，支持阶段开始、结束、失败和重试记录
- [x] 3.3 为关键 workflow 阶段接入结构化业务事件写入，并写入 `durationMs`、`status`、`attempt` 和 trace 关联字段
- [x] 3.4 控制业务事件字段体积，禁止大体积 prompt、完整响应正文和无上限 metadata 直接入库
- [x] 3.5 为 `storyboard`、`scene_asset_search`、`render_preview` 等 scene-sensitive 阶段设计 scene-level diagnostics 摘要字段，包括 `sceneCount`、`sceneId`、预期/实际 visual mode、候选数量、reason code 和最终 asset usage
- [x] 3.6 为 intent 路由、judge、materialize、render fallback 定义稳定 reason code 枚举与写入约定，避免只靠自由文本日志归因

## 4. Timeline 与 KPI 视图

- [x] 4.1 设计并实现内部可用的 workflow timeline / metrics 页面或等价后台视图
- [x] 4.2 支持按 `projectId`、`turnId`、`runId` 检索，并展示总耗时、阶段拆分、失败位置和重试次数
- [x] 4.3 在视图中补齐 trace link 或等价跳转能力，使业务 timeline 可跳转到 Dash0 trace
- [x] 4.4 统一实现关键 KPI 口径，包括 `user message -> first visible feedback`、`bootstrap`、`preview ready` 等指标
- [x] 4.5 为单个 `runId` 提供 case diagnostics 视图或展开面板，展示 scene 拆分、各 scene 的预期/实际 visual mode、未用图原因和拖尾 scene
- [x] 4.6 支持按 reason code、phase 和 scene status 过滤 case diagnostics，便于快速定位“没用图”“judge timeout”“guardrail 拒绝”等问题

## 5. 采样、保留与成本控制

- [x] 5.1 定义 traces、logs 和业务事件的采样与保留策略，区分开发、预发和生产环境
- [x] 5.2 为失败 case、慢 case 和关键用户路径增加优先保留策略
- [x] 5.3 为低价值高频事件设计降采样或摘要化规则，避免 observability 数据失控
- [x] 5.4 增加 exporter、事件写入和 timeline 查询的开关与回滚策略
- [x] 5.5 为 scene-level diagnostics 定义字段裁剪规则，禁止直接落完整候选列表、完整模型输入输出和大体积 scene payload

## 6. 验证与回归

- [x] 6.1 验证单个请求可从业务 timeline 关联到 Dash0 trace，并能跨 Vercel、Trigger 和应用代码追踪
- [x] 6.2 验证关键 workflow 阶段的 `durationMs`、`status` 和 `attempt` 记录与实际执行一致
- [x] 6.3 验证 timeline 视图和 KPI 视图可定位首反馈慢点、preview 慢点和失败阶段
- [x] 6.4 验证 observability 接入后关键路径性能开销在可接受范围内，且未引入明显回归
- [x] 6.5 输出 rollout、成本监控、回滚方案和运维检查清单
- [x] 6.6 验证单个 `runId` 的 case diagnostics 可准确回答 scene 数量、预期 visual mode、最终 asset usage 和未用图原因
- [x] 6.7 选取真实慢 case 验证 diagnostics 可定位具体拖尾 scene，并区分 intent/judge/materialize/render 四类根因
