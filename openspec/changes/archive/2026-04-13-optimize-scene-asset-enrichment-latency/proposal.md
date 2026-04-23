## Why

恢复 `scene asset search + materialize` 对 preview 的阻塞等待后，Remotion 终于能稳定消费本地素材，但 `script confirmed -> preview ready` 的总耗时也从约 2 分钟回升到约 5 分钟。当前瓶颈不只是“下载图片慢”，而是 `scene image routing -> Tavily search -> LLM judge -> materialize download/write` 整段链路过重，因此需要在不牺牲素材正确性的前提下，把这条阻塞链路系统性做轻。

## What Changes

- 保持 `scene asset enrichment` 作为 preview 前的正确性前置条件，避免再次出现“搜到图片但 Remotion 未实际消费本地素材”的结果不一致问题。
- 降低图片判图成本：仅在候选结果存在明显歧义时调用 LLM judge；为 judge 增加更快模型、超时与并发上限；在高置信度首选候选存在时直接跳过 judge。
- 降低 materialize 下载重量：限制远程素材的类型、大小与下载时长；对超重素材执行拒绝、降级或轻量化落地；避免让大 GIF 或原始大图直接占据 preview 关键路径。
- 减少进入图片搜索路径的 scene 数量：收紧 `image` intent 路由，只让真正依赖图片 grounding 的 scene 进入 Tavily 搜索，其余 scene 优先使用 motion/template/fallback visual。
- 为 `scene asset search` 的关键子步骤补齐最小化耗时观测，至少能拆分 `search / judge / download / write` 与 `per-scene` 维度，便于验证 ABC 三类优化是否生效。
- 为这条阻塞链路定义明确的预算、降级与回滚策略，确保未来性能优化不会再次通过“非阻塞但结果不同步”的方式换取速度。

## Capabilities

### New Capabilities
- `scene-asset-enrichment-latency`: 定义 scene asset enrichment 在 blocking preview 模式下的选择、判图、materialize、预算与降级约束。

### Modified Capabilities
- `workflow-performance-optimization`: 调整 preview 关键路径约束，不再要求 `scene asset enrichment` 必须作为非阻塞增强项，而是要求在保持素材正确性的前提下，通过 selective routing、bounded judge 和 lightweight materialize 控制阻塞耗时。

## Impact

- 影响代码：
  - `trigger/workspace/goalToStoryboard.ts`
  - `src/lib/workspace/sceneAssetIntent.ts`
  - `src/lib/workspace/sceneAssetSearch.ts`
  - `src/lib/workspace/sceneAssetRelevance.ts`
  - `src/lib/workspace/sceneAssetMaterialize.ts`
  - `src/lib/workspace/tavily.ts`
  - `src/lib/capabilities/remotion/generatePreview.ts`
- 影响系统：
  - Tavily 搜图与候选过滤路径
  - 模型 judge 调用的耗时、并发与超时策略
  - 本地素材下载、轻量化落地与 Remotion asset import 链路
  - preview ready 的关键路径预算与 fallback 规则
- 风险：
  - 若 `image` 路由收得过紧，可能降低部分 scene 的视觉相关性。
  - 若素材大小/类型限制过严，可能导致候选命中率下降，需要与 fallback visual 一起验证。
  - judge 降级策略若阈值设置不当，可能引入“快但选错图”的回归。
- 回滚方案：
  - 保留现有 blocking enrichment 主链路，只对 ABC 三类策略加 feature flag 或阈值配置；若效果不佳，可逐项回退 judge gating、下载限制或 image routing，而不回退到“非阻塞 preview”模型。
  - 若某项轻量化策略导致明显视觉回归，系统应回退到当前完整 materialize 行为，同时保留新增观测字段用于继续分析。
- 验证步骤：
  - 对同类 storyboard 比较变更前后的 `scene asset search` 总耗时，以及 `search / judge / download / write` 子步骤耗时。
  - 验证 preview 输出仍然只消费本地 materialized assets，不出现导出阶段远程资源回退到 `Visual unavailable` 的情况。
  - 验证 image scene 数减少后，abstract / transition / CTA 等 scene 仍能生成可接受的 motion 或 template visual。
