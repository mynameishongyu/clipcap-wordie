## Context

当前 `script confirmed -> preview ready` 路径在恢复 blocking `scene asset enrichment` 后，重新满足了 Remotion 只消费本地 materialized assets 的正确性要求，但也暴露出这条链路本身的真实耗时。实际关键路径不只是 `materialize` 下载，而是：

1. `sceneAssetIntent` 将大量 scene 路由到 `image`
2. `sceneAssetSearch` 对这些 scene 执行 Tavily 搜图与候选过滤
3. `sceneAssetRelevance` 对候选结果执行 LLM judge
4. `sceneAssetMaterialize` 下载远程素材并写入本地资产目录
5. `generateRemotionPreview` 再把本地资产复制到 Remotion 项目并生成 scene code

此前的性能优化通过“asset enrichment 非阻塞 preview”隐藏了这段成本，但也直接引入了“搜到图、下载了图、最终 scene 仍未 import 本地素材”的 correctness 问题。当前设计目标不是重新回到非阻塞模式，而是在 blocking preview 模式下压缩 ABC 三类成本：`judge` 成本、`materialize` 重量、`image` scene 数量。

相关约束：

- Remotion preview 与 export 必须继续只依赖本地 materialized assets，不再回退到远程 URL hotlink。
- 变更应尽量局限在 `scene asset enrichment` 子链路，不重做整个 storyboard 或 render 架构。
- 观测需求以“验证优化是否生效”为目标，只补最小必要粒度，不把本 change 扩展成完整 observability 平台建设。

## Goals / Non-Goals

**Goals:**

- 在 blocking preview 模式下显著缩短 `scene asset enrichment` 总耗时。
- 通过 selective routing 降低进入 Tavily 搜图与 judge 的 scene 数量。
- 通过 bounded judge 降低每个 image scene 的模型调用成本与拖尾时延。
- 通过 lightweight materialize 限制大 GIF、超大图片和慢速远程源对关键路径的影响。
- 补齐 `search / judge / download / write` 与 `per-scene` 维度的最小化耗时观测，用于验证优化效果与继续定位瓶颈。

**Non-Goals:**

- 不恢复“asset enrichment 非阻塞 preview”模式。
- 不在本 change 中重做 `generateRemotionPreview()` 的模板化渲染策略或 scene code 生成框架。
- 不引入新的外部资产搜索服务，仍以现有 Tavily 与现有模型能力为基础。
- 不在本 change 中建设完整的全局 tracing / Dash0 体系；更完整的 observability 继续由 `workflow-observability-and-tracing` 承担。

## Decisions

### 1. 保持 blocking enrichment，但把阻塞范围缩到“真正值得等”的 scene

决策：

- `scene asset enrichment` 继续作为 preview 前的正确性前置条件。
- `sceneAssetIntent` 将收紧 `image` 路由规则，只让具备明确视觉 grounding 价值的 scene 进入搜图链路。
- 抽象讲解、节奏过渡、CTA、低信息密度 scene 默认优先命中 `motion-only`、template 或 fallback visual。

原因：

- 用户当前最关心的是“搜到的图最终真的被 Remotion 使用”，这要求 preview 在 render 前拿到本地资产。
- 真实耗时的一部分来自 image scene 数量偏多；减少路由数量比在所有 scene 上做微优化收益更高。

备选方案：

- 保持现有宽松 `image` 路由，再单独优化 Tavily / judge / materialize。
  - 放弃原因：若 scene 数本身过多，后续每一步都会被线性放大，关键路径仍然难以稳定收敛。

### 2. 将 LLM judge 改成“仅歧义时触发”的 bounded decision

决策：

- 为 `sceneAssetRelevance` 增加 heuristic gating：当 top candidate 明显领先、候选过少或分数差距足够大时，直接采用 heuristic 结果，不再调用 LLM judge。
- 仅对“候选接近、场景描述复杂、heuristic 不足以分辨”的 scene 调用 judge。
- judge 使用更快模型、明确 timeout 和并发上限；超过预算后回退到 heuristic top candidate 或该 scene 的非图片 visual。

原因：

- 当前每个 image scene 都走一次模型 judge，实际把模型调用成本直接串进 preview 关键路径。
- judge 的价值主要体现在歧义候选，而不是明显优胜候选。

备选方案：

- 完全移除 judge，只保留 heuristic 排序。
  - 放弃原因：会显著增加选错图风险，尤其对产品 UI、人物、地点等细粒度视觉需求。
- 保留现有全量 judge，但只换更快模型。
  - 放弃原因：只能降低单次调用耗时，无法减少调用次数与尾部拖延。

### 3. materialize 不再默认下载“远程原件”，而是下载“preview-safe 本地资产”

决策：

- `sceneAssetMaterialize` 在下载前先检查 `content-type`、`content-length`、host 与超时预算。
- 对 GIF、超大 PNG/JPEG 或未知类型远程资源执行拒绝、降级或轻量化处理；必要时只保留静态首帧或压缩后的预览版本。
- 本地落地文件的目标是让 Remotion preview 可稳定、快速 import，而不是归档远程原始素材。

原因：

- 当前链路最大的不确定性来自未受控的大 GIF 和原始大图下载。
- 对 preview 来说，稳定、足够清晰、可快速导入的本地资产比“无损原件”更重要。

备选方案：

- 保持完整原图下载，再依赖更强网络或更长 budget。
  - 放弃原因：会继续让最慢的远程素材主导 wall time，且无法从系统设计上约束拖尾。

### 4. 用最小可用观测验证 ABC 优化，而不是等待完整 observability change 落地

决策：

- 在 `scene asset enrichment` 内补齐结构化耗时事件或 span/log 字段，至少覆盖 `sceneId`、`intent`、`searchMs`、`judgeMs`、`downloadMs`、`writeMs`、`contentType`、`fileSizeBytes`、`selectedHost`、`status`。
- 这些字段只服务于本 change 的验证与持续调优；后续完整 trace correlation 仍交给 `workflow-observability-and-tracing`。

原因：

- 没有子步骤拆分，就无法判断 A/B/C 哪一项真正生效。
- 仅依赖最终一条 `workspace asset search materialized` 日志无法指导后续阈值调整。

备选方案：

- 等待完整 observability change 完成后再做性能优化。
  - 放弃原因：会把当前已知的严重延迟问题继续留在主流程中，缺少现实可行性。

## Risks / Trade-offs

- [Risk] `image` 路由收紧过头，导致部分 scene 失去原本有帮助的真实图片素材  
  → Mitigation：先以可配置阈值上线，并对 hero/demo/product scene 保持白名单优先权；对命中率与视觉回归做抽样复核。

- [Risk] judge gating 使用 heuristic 直出后，局部 case 的选图质量下降  
  → Mitigation：只在高置信度条件下跳过 judge，并为 ambiguous case 保留模型裁决；记录 heuristic-skip 与 judge-hit 的结果，便于后续对比。

- [Risk] 下载限制和轻量化规则过严，导致素材命中率下降或频繁 fallback  
  → Mitigation：把类型、大小、超时阈值做成可调配置，并在 rollout 期间观察 fallback 比例与 preview 质量。

- [Risk] 轻量化处理引入额外 CPU 开销，抵消部分网络节省  
  → Mitigation：优先用“拒绝超重资源 + 直接下载较小资源”降低关键路径，只有在收益明显时才增加转码步骤。

- [Risk] 新增局部观测字段继续膨胀日志体积  
  → Mitigation：仅记录 asset enrichment 必需字段，对高频 payload 做摘要化，不在本 change 中引入全量原始候选日志。

## Migration Plan

1. 先引入观测字段与配置开关，在现有 blocking enrichment 路径上记录基线数据。
2. 分阶段上线 A/B/C 三类优化：
   - A：judge gating、timeout、并发上限
   - B：类型/大小/时长限制与 lightweight materialize
   - C：更严格的 image intent routing
3. 每阶段都比较 `scene asset search` 总耗时、子步骤耗时、fallback 比例、preview 质量与导出稳定性。
4. 若某一阶段引入明显视觉回归或命中率下降，则单独回退该阶段配置，不回退整个 blocking enrichment 主模型。

回滚策略：

- 保留当前 blocking enrichment 与本地资产 import 主链不变。
- 对 judge gating、下载限制、image routing 使用独立 feature flag 或阈值配置，允许逐项关闭。
- 若 lightweight materialize 出现兼容性问题，可回退到当前原始下载逻辑，同时保留观测字段继续分析。

验证步骤：

- 使用同类 storyboard 数据集，对比优化前后的总 preview 耗时和 `search / judge / download / write` 子步骤耗时。
- 验证生成出的 scene code 继续只引用本地 asset import，不重新引入远程 URL。
- 验证导出阶段不再因 remote source 加载失败而退回 `Visual unavailable`。
- 对抽象 scene、过渡 scene、CTA scene 抽样验证：在减少 image 路由后，motion/template/fallback 结果仍然可接受。

## Open Questions

- `image` intent routing 的首版阈值如何定义更稳：基于 scene type、关键词模式，还是显式 visual dependency score？
- judge 的首版“高置信度可跳过”阈值如何设定，才能在节省调用次数和避免错判之间取得平衡？
- 对 GIF 的首版策略应是完全拒绝、只取首帧，还是允许小尺寸 GIF 直接通过？
- lightweight materialize 是否需要引入统一图片转码步骤，还是先只做下载前的 size/type guardrails？
