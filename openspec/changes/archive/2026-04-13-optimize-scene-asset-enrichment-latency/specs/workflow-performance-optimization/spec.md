## REMOVED Requirements

### Requirement: Scene asset enrichment SHALL NOT block preview readiness
**Reason**: 实际运行表明，将 `scene asset enrichment` 强行降为非阻塞增强项会造成“图片搜索与 materialize 已完成，但 Remotion preview 仍未消费本地素材”的结果不一致问题，最终在 export 阶段回退到 `Visual unavailable`。该要求不再符合当前 correctness 约束。
**Migration**: preview 路径改为在生成 scene code 前等待经过预算约束的 `scene asset enrichment` 完成；超出 budget 的单个 scene 必须通过 selective routing、bounded judge 和 lightweight materialize 降级，而不是让整个 preview 提前绕过本地素材链路。

## ADDED Requirements

### Requirement: Scene asset enrichment SHALL preserve correctness while remaining latency-bounded
系统在 `script confirmed -> preview ready` 阶段 SHALL 保证：若某个 scene 需要外部视觉素材，则 Remotion preview 只在该 scene 的本地 materialized asset 已准备完成后才允许消费该素材。同时，系统 MUST 通过 selective routing、bounded judge、lightweight materialize 与 scene-level fallback，将这条 blocking enrichment 链路控制在明确的延迟预算内。

#### Scenario: 需要真实图片的 scene 在本地素材就绪后进入 render
- **WHEN** 一个 scene 被判定为必须使用外部图片素材，且该素材在配置预算内成功 materialize 为本地 asset
- **THEN** 系统在生成对应 scene code 前等待该本地 asset 就绪
- **THEN** 预览与导出继续只引用该本地 asset，而不是远程 URL

#### Scenario: 单个 scene 的 enrichment 超预算时使用 scene-level fallback
- **WHEN** 某个 scene 的搜索、judge 或 materialize 超出其预算，或候选资源违反大小、类型或时长限制
- **THEN** 系统只让该 scene 回退到 template、motion-only 或 fallback visual
- **THEN** 系统不得因为单个 scene 的资产问题而无限阻塞整个 preview ready

#### Scenario: 非关键后置动作仍然不阻塞 preview ready
- **WHEN** 所有参与 render 的 scene 都已确定其本地 asset 或 scene-level fallback visual
- **THEN** 系统继续生成并交付 preview ready 结果
- **THEN** thumbnail、Remotion 项目上传或其他非关键后置动作仍不得阻塞 preview ready
