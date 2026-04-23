## 1. 启动链路瘦身

- [x] 1.1 重构 `start_from_request` 的初始化路径，使 API 同步阶段只完成最小 turn/run 创建、assistant placeholder 与 progress hint 返回
- [x] 1.2 将 URL extraction、research decision、goal generation 与 workflow trigger 下沉到独立的后台 bootstrap 执行段
- [x] 1.3 消除启动阶段对同一 `runId` 的重复 `createQueuedPipelineRun()`，统一改为单次创建、后续更新
- [x] 1.4 调整 conversation timeline / task 状态写入，确保 bootstrap 期间存在 durable 的工作中反馈而非仅依赖前端临时 draft

## 2. 前置来源并行化

- [x] 2.1 重构 research 编排，使 `research decision` 可在不等待 URL extraction 结果的前提下基于 message 与 recent history 先行判定
- [x] 2.2 将 URL extraction 与 Tavily text research 改为并行执行，并在完成后统一合并 `sourceDocuments` 与 `sourceContext`
- [x] 2.3 为并行来源链路补齐部分成功、无结果、超时与失败回退逻辑，保证 bootstrap 可继续推进
- [x] 2.4 更新 goal/script 前的状态推进与错误处理，确保来源并行化后 run/step 状态仍保持一致

## 3. Preview 主链收缩

- [x] 3.1 重构 `script confirmed -> preview ready` 的阶段边界，只将 preview 必需动作保留在关键路径
- [x] 3.2 将 thumbnail 生成、Remotion project upload 与其他非关键 artifact 持久化后移到 preview ready 之后
- [x] 3.3 调整 post-preview 失败处理，确保后置持久化失败不会回退已生成的 preview 结果
- [x] 3.4 更新前端或任务状态文案，明确区分 `preview ready` 与后续持久化/增强阶段

## 4. 素材降级与模板加速

- [x] 4.1 将 scene asset search、图片判定与 materialize 从 preview 强依赖降为增强项，并补齐 template/fallback visual 兜底路径
- [x] 4.2 定义 `open_template` 配置开关、scene router 与模板命中/回退语义
- [x] 4.3 设计并实现 `scene DSL + fixed Remotion templates` 的模板化加速路径，并保证未命中或失败时可回退到自由 scene TSX
- [x] 4.4 调整 render 阶段预算，使模板路径、素材增强与自由生成路径在超预算时都能走明确 fallback 或可重试状态

## 5. Render 无损优化

- [x] 5.1 梳理 `generateRemotionPreview()` 的内部耗时分布，定位 prompt 体积、重复准备、重复校验与重试带来的主要开销
- [x] 5.2 收缩自由 scene codegen 所需上下文，避免为每个 scene 重复注入对质量无显著帮助的全量信息
- [x] 5.3 为 scene code、runtime validation 等高耗时步骤设置有界重试与超时，避免单个 case 无限放大 render 耗时
- [x] 5.4 将不影响最终视觉结果的 render 准备步骤并行化或复用缓存，同时保持现有自由 scene TSX 路径可用

## 6. 离线模板生产

- [x] 6.1 定义模板候选的结构化 schema，包括 `template kind`、`slots`、`layout/motion preset` 与 `constraints`
- [x] 6.2 设计离线任务，从高质量 scene 结果中抽取 `template candidates`，并保证该流程不阻塞用户主路径
- [x] 6.3 建立模板候选的评估、验收与正式入库流程，禁止原始 scene TSX 直接作为正式模板入库
- [x] 6.4 为模板库补充版本化、启停和回滚机制，支持低质量模板快速下线

## 7. 验证与回归

- [x] 7.1 为启动链路、并行 research、preview ready 阶段边界补充自动化测试或可重复验证脚本
- [x] 7.2 对典型 case 记录优化前后耗时对比，包括“首个稳定反馈”“preview ready”以及模板命中率
- [x] 7.3 验证取消、重试、等待确认与 script retry 在新 run/update 语义下保持兼容
- [x] 7.4 验证 `open_template` 开关、模板未命中回退、素材缺失 fallback visual 与自由 scene 路径共存时的结果稳定性
- [x] 7.5 验证离线模板候选抽取、验收与模板库回滚不会影响在线渲染主路径
- [x] 7.6 输出回滚方案与开关策略，确保 bootstrap 拆分、素材降级与模板加速、render 无损优化、离线模板生产可按阶段独立回退
