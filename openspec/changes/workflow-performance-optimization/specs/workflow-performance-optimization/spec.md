## ADDED Requirements

### Requirement: Project conversation request startup SHALL return stable workflow feedback before heavy bootstrap work
系统在处理 `start_from_request` 类型的项目对话请求时，必须先完成最小化初始化并向用户返回稳定的 workflow 反馈，然后再执行重型 bootstrap。该同步返回不得等待 URL extraction、Tavily text research、goal generation 或 Trigger workflow 启动完成。

#### Scenario: 新请求先返回稳定占位状态
- **WHEN** 用户发送一个可识别为 `start_from_request` 的新视频请求
- **THEN** 系统先创建最小 turn 与 run 状态
- **THEN** 系统立即返回 assistant placeholder、active task 与 progress hint
- **THEN** 重型 bootstrap 在响应之后的后台阶段继续执行

#### Scenario: 用户在 bootstrap 期间看到 durable 工作中状态
- **WHEN** 后台 bootstrap 尚未完成
- **THEN** conversation timeline 或 task 状态中仍存在稳定的工作中反馈
- **THEN** 用户不需要等待完整 goal/script 产出才知道系统已开始处理请求

### Requirement: Request bootstrap SHALL minimize the startup critical path and avoid duplicate run creation
系统必须将 `start_from_request` 的 bootstrap 关键路径限制为必要最小步骤，并避免重复创建同一个 pipeline run。run 初始化在启动阶段只能发生一次，后续 goal、research 与 workflow 触发只允许更新现有 run 状态。

#### Scenario: 启动阶段只创建一次 run
- **WHEN** 系统开始处理一个新的 `start_from_request` 请求
- **THEN** 系统只创建一次 queued/running run 记录
- **THEN** 后续不会为同一 `runId` 再次执行重复的 queued run 初始化

#### Scenario: bootstrap 通过更新现有 run 推进状态
- **WHEN** URL extraction、research、goal generation 或 Trigger 启动在后台继续进行
- **THEN** 系统通过更新现有 run 与 step 状态推进工作流
- **THEN** 不会通过重新创建 run 的方式覆盖先前状态

### Requirement: Source extraction and text research SHALL run in parallel during bootstrap
当请求需要处理显式 URL 来源和外部文本 research 时，系统必须并行执行 URL extraction 与 Tavily text research，并在两者完成后统一合并 source documents。系统不得将这两条独立来源链路固定为串行执行。

#### Scenario: URL extraction 与 Tavily research 并行执行
- **WHEN** 用户消息同时需要 URL extraction 且 research decision 判定需要外部文本 research
- **THEN** 系统并行启动 URL extraction 与 Tavily text research
- **THEN** 系统在两条链路完成后合并 source documents 与 `sourceContext`

#### Scenario: 只有一条来源链路命中时仍可继续 bootstrap
- **WHEN** URL extraction 与 Tavily text research 中仅有一条返回可用来源
- **THEN** 系统使用可用来源继续构建 `sourceContext`
- **THEN** 不会因为另一条并行链路未命中而阻塞整个 bootstrap

### Requirement: Preview ready SHALL exclude non-critical persistence and enrichment work from the critical path
系统在 `script confirmed -> preview ready` 阶段必须只保留生成可预览结果所必需的关键动作。thumbnail 生成、Remotion 项目上传、非关键 artifact 持久化与其他 enrich 动作不得阻塞 preview ready。

#### Scenario: preview ready 不等待非关键上传
- **WHEN** Remotion preview 已经生成并通过最小运行时校验
- **THEN** 系统即可将任务推进到 preview ready / success 状态
- **THEN** thumbnail、Remotion 项目上传及其他非关键持久化可在后续阶段继续执行

#### Scenario: 非关键持久化失败不回退已生成预览
- **WHEN** preview ready 之后的非关键 artifact 持久化失败
- **THEN** 系统保留已经可用的 preview 结果
- **THEN** 系统将失败限制在后置持久化阶段，而不是回退整个 preview ready 结果

### Requirement: Scene asset enrichment SHALL NOT block preview readiness
scene asset search、图片判定与本地 materialize 必须被视为 render 增强能力，而不是 preview ready 的强前置条件。当素材搜索或素材落地未及时完成时，系统仍必须能够使用 template visual 或 fallback visual 生成可预览结果。

#### Scenario: scene asset search 未命中时仍然生成 preview
- **WHEN** 一个或多个 scene 没有搜索到高相关图片，或图片判定结果为低置信度
- **THEN** 系统仍然继续生成 Remotion preview
- **THEN** 未命中素材的 scene 使用 template visual 或 fallback visual 渲染

#### Scenario: materialize 失败时不阻塞 preview ready
- **WHEN** scene image materialize 失败或超时
- **THEN** 系统不因该失败阻塞 preview ready
- **THEN** 系统仅将该 scene 标记为缺少 enrich 视觉素材

### Requirement: Template acceleration SHALL be controlled by `open_template`
系统必须提供一个由 `open_template` 控制的模板化 render 加速路径。开启后，scene 应优先尝试命中 `scene DSL + fixed Remotion templates`；未命中或开关关闭时，系统必须回退到现有自由 scene TSX 生成路径。

#### Scenario: `open_template` 开启时优先命中模板
- **WHEN** `open_template = true` 且某个 scene 被 router 判定为高置信度模板场景
- **THEN** 系统优先使用 `scene DSL + fixed Remotion templates` 生成该 scene
- **THEN** 该 scene 不再要求默认进入自由 scene TSX 代码生成

#### Scenario: `open_template` 关闭或未命中时回退到自由 scene 路径
- **WHEN** `open_template = false`，或 scene 未命中模板，或模板路径执行失败
- **THEN** 系统使用现有自由 scene TSX 生成路径继续生成该 scene
- **THEN** 模板路径不会阻塞默认自由生成路径

### Requirement: Template library growth SHALL run off the user critical path
系统必须在用户主路径之外建立模板库增长机制。模板候选的抽取、评估与入库必须通过离线任务执行，不得阻塞 `preview ready` 或其他用户关键路径。

#### Scenario: 在线请求不会实时生成并入库模板
- **WHEN** 用户请求在在线主路径中完成 scene 渲染
- **THEN** 系统只执行模板命中、模板渲染或自由 scene 回退
- **THEN** 系统不会在该主路径中实时创建并写入新的正式模板

#### Scenario: 离线任务从高质量 scene 中抽取模板候选
- **WHEN** 系统识别到一个高质量、可复用的 scene 结果
- **THEN** 离线任务可以从该结果中抽取 `template candidates`
- **THEN** 候选模板进入评估与验收流程，而不是直接进入正式模板库

### Requirement: Template candidates SHALL be structured and reviewed before promotion
系统必须将离线抽取的模板候选表示为结构化模板，而不是历史 scene TSX 代码片段。只有通过评估与验收的候选模板才能被提升为正式模板。

#### Scenario: 模板候选以结构化 schema 表示
- **WHEN** 离线任务从成功 scene 中抽取模板候选
- **THEN** 候选模板至少包含模板类型、可变槽位、布局或动画预设以及约束信息
- **THEN** 系统不会将原始 scene TSX 直接作为正式模板入库

#### Scenario: 模板候选需通过评估后才能入库
- **WHEN** 一个模板候选尚未通过质量评估或人工验收
- **THEN** 该候选不得进入正式模板库供在线 router 默认命中
- **THEN** 系统仅允许通过验收的模板进入可用模板集合

### Requirement: Render execution SHALL reduce duplicate work and bound retries across template and free-form paths
系统必须减少 `generateRemotionPreview()` 中的重复 prompt 上下文、重复准备步骤与重复校验，并为模板路径与自由 scene 路径中的高耗时步骤设置有界重试。系统不得通过无界重试来维持 preview 生成。

#### Scenario: 自由 scene prompt 仅保留必要上下文
- **WHEN** 系统为未命中模板的 scene 生成自由代码或渲染上下文
- **THEN** prompt 仅包含该 scene 所需的必要共享上下文与相邻摘要
- **THEN** 系统不会为每个 scene 重复注入对质量无显著帮助的全量上下文

#### Scenario: 模板路径与自由路径均采用有界重试
- **WHEN** 模板渲染、scene code 生成、runtime validation 或其他关键 render 步骤发生失败
- **THEN** 系统仅在配置上限内进行重试
- **THEN** 达到上限后进入 fallback、明确失败或可重试状态，而不是继续无界等待

### Requirement: Workflow stages SHALL enforce explicit latency budgets and degrade predictably
系统必须为请求启动阶段和 preview 生成阶段定义显式延迟预算，并在超出预算或关键依赖失败时进入明确的 fallback、失败、可重试或后置处理状态。系统不得通过无界重试或无限制等待来维持关键路径。

#### Scenario: 启动阶段超预算时仍保持工作流可继续
- **WHEN** 请求启动阶段中的某个非关键步骤超出预算
- **THEN** 系统对用户保持已启动的任务与稳定进度反馈
- **THEN** 系统通过延后、失败标记或可重试策略继续推进 workflow，而不是让启动阶段无限等待

#### Scenario: render 阶段超预算时进入模板或 fallback 路径
- **WHEN** render 阶段中的 scene code、template 渲染或 preview 校验超过配置预算
- **THEN** 系统在达到预算阈值后停止继续重试
- **THEN** 系统进入模板、fallback visual、明确失败或可重试状态，而不是继续阻塞 preview ready
