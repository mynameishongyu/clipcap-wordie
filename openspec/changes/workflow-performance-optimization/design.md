## Context

当前工作流存在两个核心性能问题：

1. `start_from_request` 的启动链虽然已经通过 `after()` 放到响应后继续执行，但后台 bootstrap 仍然包含 URL 抓取、research 判定、Tavily 文本搜索、goal 生成、重复 run 初始化、扣费、Trigger 启动等一整段串行逻辑，导致用户侧只能看到弱占位状态，而真正稳定的 assistant/tool timeline 要等数十秒甚至更久才出现。
2. `script confirmed -> preview ready` 阶段严格串行执行 `tts -> storyboard -> scene asset search -> image materialize -> generateRemotionPreview -> bundle validate -> upload`。其中 `generateRemotionPreview()` 采用“1 次 design guide + N 次自由 scene TSX 生成 + 重试 + bundling + browser validation”的结构，天然有较高延迟上限。

现状约束：

- 当前系统使用 Next.js API route + Trigger workflow + Supabase 风格 run/step 存储。
- `start_from_request`、`retry`、`hitl confirm` 都依赖现有 run 状态机，不能破坏取消、重试、等待确认语义。
- 文本 research、scene asset search、Remotion preview 都已经接入主流程，优化时不能简单移除功能。
- 本 change 仅覆盖性能优化，不引入独立 observability 产品或全局 tracing 体系。

## Goals / Non-Goals

**Goals:**

- 将“用户发送请求 -> 首个稳定反馈”压缩到秒级，并让反馈具有明确的 assistant/task/progress 语义，而不是仅依赖前端临时 draft。
- 将 `start_from_request` 的重型 bootstrap 从 API 热路径中拆出，缩短关键串行链路。
- 将前置 source extraction 与 Tavily text research 改造为后台并行执行。
- 消除重复 run 创建和多余的热路径写入，统一 run 生命周期更新方式。
- 将 `preview ready` 的关键路径收缩为“能预览所必需”的最小链路，后移非关键动作。
- 在保持当前自由 scene TSX 路径可用的前提下，引入一个由 `open_template` 控制的模板化加速路径。
- 将 scene asset search、图片判定与 materialize 从 preview 强依赖降为增强项，并在素材缺失时允许 template/fallback visual 兜底。
- 建立模板库的离线生产机制，从成功 scene 中持续抽取和沉淀模板候选。
- 同时缩减 `generateRemotionPreview()` 的重复工作和无效等待。
- 为启动阶段和 render 阶段定义明确的预算、重试边界与失败回退策略。

**Non-Goals:**

- 不在本 change 中引入 Dash0、OpenTelemetry 或新的全局观测基础设施。
- 不重写整个 storyboard 或 TTS 能力，只优化编排和 render 路线。
- 不在本 change 中完成最终的视频导出链路重构，重点是 preview ready。
- 不要求 `open_template` 在所有环境中默认开启。
- 不将模板化 render 扩展为完全替代自由 scene TSX 的唯一主路径。
- 不要求离线模板生产在首次上线时做到完全自动审核入库。

## Decisions

### 1. 将 `start_from_request` 拆为“同步最小初始化 + 后台 bootstrap task”

决策：

- API 同步阶段只做：
  - prompt 校验
  - intent routing
  - 最小 turn/run 创建
  - 返回稳定 assistant placeholder、active task、progress hint
- 后台 bootstrap task 负责：
  - URL extraction
  - research decision
  - Tavily text research
  - goal generation
  - workflow trigger

原因：

- 当前最大的用户痛点是“发出请求后要等很久才感觉系统真的开始工作”。
- 即使 API 已经用 `after()`，用户当前仍主要依赖后续 snapshot/timeline 更新才能看到真实进展，因此 bootstrap 的 durable 输出必须更早、更明确。
- 将 bootstrap 变成单独后台阶段，能让后续并行化、重试和 budget 管理更清晰。

备选方案：

- 保持现有 `after()` continuation，只在前端加强 optimistic draft。
  - 放弃原因：只能改善“视觉感知”，不能从架构上缩短后台串行链路，也不利于后续 budget/重试治理。

### 2. 文本 research 路径改为“URL extraction 与 Tavily text research 并行”

决策：

- `research decision` 先基于 message + recent history 快速判定是否需要搜索。
- 如果需要搜索：
  - URL extraction
  - Tavily text research
  两条并行执行。
- goal/script 输入在合并 source documents 后统一生成。

原因：

- 当前 URL extraction 与 Tavily research 是前后串行，浪费了等待时间。
- 两者最终产出形式都归并为 source documents / `sourceContext`，天然适合并发收敛。

备选方案：

- 先等 URL extraction 完成，再把结果作为 research decision 上下文。
  - 放弃原因：更精确，但增加启动关键路径，收益不如并行化明显。

### 3. `createQueuedPipelineRun()` 在启动阶段只允许一次

决策：

- 初始 run 在 API 初始化阶段创建一次。
- bootstrap 完成后只做 `updatePipelineRun()` 与 step 更新，不再重复创建 queued run。

原因：

- 当前 `start_from_request` 路径先创建 pending run，后面生成 goal 后又再次 `createQueuedPipelineRun()`，会放大写入开销并增加状态理解复杂度。
- 单 run、多阶段 update 更符合后续性能和观测治理。

备选方案：

- 保留双次创建，靠幂等覆盖。
  - 放弃原因：会继续污染热路径，并让 run 元数据的一致性更脆弱。

### 4. `preview ready` 关键路径只保留必需动作

决策：

- `preview ready` 所需关键路径限定为：
  - TTS
  - storyboard
  - render 所需最小视觉素材准备
  - preview bundle 生成与最小校验
- 后移到 preview ready 之后的动作：
  - thumbnail 生成
  - Remotion project upload
  - 非关键 artifact 持久化
  - 其他 enrich 类动作

原因：

- 用户最关心的是“可以预览”，而不是同一时刻拿到所有持久化产物。
- 现在 preview 后还串着多步上传和衍生产物生成，直接拉长 render 段总体耗时。

备选方案：

- 保持所有产物强一致地一次性完成。
  - 放弃原因：对用户感知没有增益，但会持续拉长 preview ready。

### 5. scene asset search 改为“不阻塞 preview ready”的增强项

决策：

- scene asset search 保留，但从 preview ready 的强依赖降为增强项。
- 若搜索、图片判定或 materialize 失败：
  - preview 仍可基于 template visual 或 fallback visual 产出
  - 后续可异步补充素材并触发增量更新

原因：

- 当前 asset search 已经并发，但它后面还有模型判图与图片 materialize，不应继续占据 preview 主链。
- 对短视频预览而言，“先有可预览结果”优先级高于“每个 scene 都命中图片”。

备选方案：

- 彻底移除 asset search。
  - 放弃原因：会明显损害视觉质量，不符合产品方向。

### 6. 引入由 `open_template` 控制的模板化 render 加速路径

决策：

- 新增 `open_template` 配置开关。
- 当 `open_template = true` 时：
  - scene 先经过 router 判断是否命中模板
  - 命中时走 `scene DSL + fixed Remotion templates` 加速路径
  - 未命中时回退到现有自由 scene TSX 路径
- 当 `open_template = false` 时：
  - 整体保持现有自由 scene TSX 主路径

原因：

- 模板库对高频信息型 scenes 有明显加速价值，但复杂长尾场景仍需要自由生成。
- 使用显式开关可以让 demo 阶段按环境或实验范围逐步启用，控制产品效果风险。

备选方案：

- 直接将模板化路径设为全局默认主路径。
  - 放弃原因：对复杂 case 的命中策略和视觉质量风险过高。

### 7. render 同时采用无损优化与模板命中优化

决策：

- 即使启用模板路径，也继续优化不改变输出语义的内部执行开销，包括：
  - 收缩自由 scene codegen 的 prompt 上下文，只传当前 scene、必要的相邻摘要和共享 design/context
  - 消除可复用的重复准备步骤与重复校验
  - 将不影响最终视觉结果的准备步骤并行化或后移
- 模板命中与自由生成两条路径共享统一的 preview ready 阶段边界与后置持久化策略

原因：

- 模板路径只能覆盖一部分高频 scenes，剩余场景仍然需要自由生成的无损提速。
- 两条路径并存时，阶段边界和状态语义必须保持一致，避免引入新的复杂性。

### 8. 模板库通过离线路径持续增长，而不是在用户主路径中实时生成

决策：

- 模板库的建立分为两部分：
  - 初始模板库：由人工或半人工先准备一批高频模板
  - 持续增长模板库：由离线任务从高质量 scene 结果中抽取 `template candidates`
- 在线主路径只负责：
  - scene router 命中模板
  - 模板渲染
  - 未命中或失败时回退到自由 scene TSX
- 离线路径负责：
  - 收集高质量 scene 样本
  - 抽取结构化模板候选
  - 聚类、评估与验收
  - 将通过验收的模板写入正式模板库

原因：

- 模板抽取和归纳不应阻塞用户的 preview 生成。
- 直接把某次成功的 TSX 代码原样放进模板库，会导致模板不可维护、难以复用且风格漂移。
- 使用离线路径可以让模板库逐步贴近真实高频场景，同时控制质量风险。

备选方案：

- 在用户主路径中实时从当前 scene 生成新模板并立即入库。
  - 放弃原因：会显著拉长主路径，并引入大量低质量、未验证模板。

### 9. 模板候选必须以结构化模板形式入库

决策：

- 离线任务不得直接把自由 scene TSX 原样写入模板库。
- 模板候选至少需要抽象为：
  - `template kind`
  - `slots`
  - `layout/motion preset`
  - `constraints`
  - 可选的视觉 token
- 只有通过评估与验收的候选模板才能进入正式模板库。

原因：

- 模板库需要服务于后续 router 命中和参数化复用，必须保持结构化而非历史代码片段化。
- 结构化模板更适合做版本管理、命中统计、淘汰和持续演进。

### 10. 为两个关键阶段定义硬性 budget 与失败边界

决策：

- 启动阶段 budget：
  - API 返回稳定反馈：秒级
  - bootstrap 到 script 待确认：设定目标上限并持续压缩
- render 阶段 budget：
  - 对 scene code、runtime validation 等高耗时步骤设定有界重试与超时
  - 模板路径、asset enrich 与自由 scene 路径都必须在超出预算时进入明确失败、fallback 或可重试状态，而不是继续无界重试

原因：

- 没有明确 budget，后续很容易在新增功能时再次把关键路径拖长。
- 性能优化需要成为 workflow 合同的一部分，而不是实现细节。

## Risks / Trade-offs

- [启动阶段拆分后 durable timeline 更依赖后台同步] → Mitigation：API 返回时就生成稳定 assistant placeholder 和 progress hint，避免只依赖前端 draft。
- [run 状态迁移可能影响取消、重试、等待确认逻辑] → Mitigation：保留现有 run 状态语义，只重构启动与更新方式，不改变 task status contract。
- [template/fallback visual 可能影响复杂 case 质量] → Mitigation：仅在 `open_template` 启用且命中置信度达标时走模板路径，未命中时回退到自由 scene TSX。
- [离线模板生产可能把偶然成功的 scene 沉淀成低质量模板] → Mitigation：模板候选必须经过结构化抽取、评估与验收后入库，不允许原样自动入库。
- [render 优化若过度收缩 prompt 或重试，可能影响个别复杂 case 质量] → Mitigation：先以保守阈值上线，通过基准 case 对比脚本、scene code 与最终预览效果后再收紧。
- [后移持久化可能增加 preview ready 与最终资产一致性窗口] → Mitigation：把 preview ready 与 post-preview persistence 明确分阶段，失败时可重试后置阶段而不影响已就绪预览。

## Migration Plan

1. 第一阶段：
   - 拆分 `start_from_request` 为最小同步初始化与后台 bootstrap。
   - 引入稳定 placeholder / progress hint 的 durable 输出。
   - 合并 run 创建逻辑，去掉重复 queued run 初始化。
2. 第二阶段：
   - 将 URL extraction 与 Tavily text research 并行化。
   - 调整 goal/script 前置链路与失败回退。
3. 第三阶段：
   - 重构 `preview ready` 关键路径，后移非关键持久化。
   - 将 asset search 从主链降为增强项，并补齐 template/fallback visual。
4. 第四阶段：
   - 引入 `open_template`、scene router 与 `scene DSL + fixed Remotion templates` 的优化路径。
   - 对自由 scene code prompt、重试与 runtime validation 做无损优化。
   - 基于基准 case 校准 render 阶段的预算、模板命中阈值与重试边界。
5. 第五阶段：
   - 增加离线模板候选抽取、评估与入库流程。
   - 建立模板库版本化、验收与淘汰机制。

回滚方案：

- 若 bootstrap 拆分导致状态问题，可回退到原先单段 continuation 逻辑。
- 若 preview 主链重构导致结果不稳定，可临时恢复原有 blocking asset/persistence 路线。
- 若模板路径影响复杂 case 产出质量，可先关闭 `open_template`，恢复纯自由 scene TSX 路线。
- 若 render 无损优化影响复杂 case 产出质量，可逐项回退 prompt、重试或校验层面的优化。
- 若离线模板生产引入低质量模板，可冻结新模板入库并回退到上一版本模板库。

## Open Questions

- 是否要把“preview ready”与“all artifacts ready”拆成两个对外 task phase，以避免 UI 语义混淆？
- `open_template` 应该是全局配置、workspace 级配置，还是 run 级实验配置？
- scene router 的命中置信度与模板优先级应如何定义，才能避免错误命中复杂场景？
- 离线模板候选的质量门槛应如何定义，例如运行稳定性、复用率、人工验收比例与命中后效果评分？
- `generateRemotionPreview()` 中哪些上下文是真正影响质量的，哪些可以安全裁剪以缩短 prompt 与响应时间？
- scene code 与 runtime validation 的重试边界应如何设置，才能在 demo 阶段同时兼顾质量与时延？
