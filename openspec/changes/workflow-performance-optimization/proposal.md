## Why

当前项目工作流的整体耗时已经明显影响可用性，尤其是用户发送请求后的首个稳定反馈过慢，以及 `script -> preview` 阶段的 `Remotion` 预览生成通常需要 3-5 分钟。随着文本 research、scene asset search、自由生成 scene TSX 等能力叠加，现有串行链路已经不再适合继续承载主流程。

## What Changes

- 将 `start_from_request` 的重型启动逻辑从 API 初始化阶段彻底下沉到后台 workflow bootstrap，API 同步阶段只保留最小创建与即时反馈。
- 为用户首条请求返回稳定的 assistant placeholder、task 状态和 progress hint，确保“已接单并开始工作”的反馈在秒级出现。
- 将前置 URL 抓取、文本 research 与后续 goal/script 生成的执行顺序重构为“同步最小化 + 后台并行化”，减少首反馈前与 script 待确认前的关键路径长度。
- 消除重复的 run 初始化与不必要的热路径写入，统一用一次创建、多次更新的方式维护 run 状态。
- 重新划分 `script confirmed -> preview ready` 阶段的关键路径，只保留 preview 必需动作，延后 thumbnail、Remotion 项目上传及其他非关键持久化。
- 将 scene asset search、图片判定与 materialize 从 preview 强依赖降为增强项；素材缺失或失败时允许使用 template/fallback visual 继续生成 preview。
- 增加 `open_template` 配置开关，在启用时让 render 优先命中 `scene DSL + fixed Remotion templates` 加速路径，未命中或开关关闭时回退到现有自由 scene TSX 主路径。
- 增加模板库的离线生产链路，从高质量 scene 结果中异步抽取 `template candidates`，经评估与验收后持续补充正式模板库。
- 同时优化 `generateRemotionPreview()` 内部的 prompt 体积、重试策略、校验顺序与可并发准备步骤。
- 为启动阶段和 render 阶段定义明确的延迟预算、重试边界与失败回退策略。

## Capabilities

### New Capabilities
- `workflow-performance-optimization`: 定义项目工作流在启动阶段、script confirmed 阶段与 preview ready 阶段的性能预算、关键路径拆分，以及由 `open_template` 控制的模板化 render 加速约束。

### Modified Capabilities
- 无

## Impact

- 影响代码：
  - `src/app/api/projects/[projectId]/messages/route.ts`
  - `src/lib/data/project-conversations-repository.ts`
  - `trigger/workspace/goalToStoryboard.ts`
  - `src/lib/capabilities/remotion/generatePreview.ts`
  - `src/lib/workspace/sceneAssetSearch.ts`
  - `src/lib/workspace/sceneAssetMaterialize.ts`
  - `src/app/(authenticated)/project/[projectId]/_components/ProjectConversationProvider.tsx`
- 影响系统：
  - Next.js API request/response 路径
  - Trigger workflow 启动与继续执行路径
  - Tavily / Firecrawl / 模型调用的并发编排
  - Remotion preview 构建、校验与上传链路
  - 模板库的离线候选抽取、验收与入库链路
- 风险：
  - 工作流阶段边界会变化，需谨慎处理 run 状态一致性、取消语义、重试语义与 UI 进度提示。
  - 模板化路径和 fallback visual 需要通过 `open_template` 与命中策略控制，避免对复杂 case 的产品效果造成不可控影响。
