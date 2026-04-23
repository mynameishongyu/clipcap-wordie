## ADDED Requirements

### Requirement: Scene image routing SHALL only search external images for visually dependent scenes
系统 SHALL 在决定 scene 是否进入外部图片搜索链路时优先识别该 scene 是否真的依赖真实图片 grounding。抽象讲解、节奏过渡、CTA、低信息密度 scene MUST NOT 默认进入 `image` 搜索路径，而必须优先使用 `motion-only`、template 或 fallback visual。

#### Scenario: 抽象或过渡 scene 默认不进入图片搜索
- **WHEN** 一个 scene 主要承担抽象说明、情绪过渡、节奏连接或 CTA 作用，且没有明确的人物、产品、地点或界面截图需求
- **THEN** 系统不为该 scene 启动外部图片搜索
- **THEN** 系统将该 scene 路由到 `motion-only`、template 或 fallback visual

#### Scenario: 明确依赖真实视觉锚点的 scene 才进入图片搜索
- **WHEN** 一个 scene 明确需要展示人物、地点、产品实物、真实界面或其他高价值视觉锚点
- **THEN** 系统允许该 scene 进入外部图片搜索链路
- **THEN** 系统仅为被识别为视觉依赖的 scene 支付 Tavily 搜索与后续 enrichment 成本

### Requirement: Scene image judging SHALL be conditional and latency-bounded
系统 MUST NOT 对每个 image scene 无差别执行 LLM judge。仅当候选结果存在真实歧义时，系统才允许调用模型 judge；所有 judge 调用 SHALL 受模型选择、并发上限与超时预算约束。

#### Scenario: 明显优胜候选直接跳过 judge
- **WHEN** 一个 image scene 的 top candidate 在启发式排序中明显领先，或候选数量过少且不存在明显歧义
- **THEN** 系统直接采用该候选
- **THEN** 系统不再为该 scene 调用 LLM judge

#### Scenario: 歧义候选触发有界 judge
- **WHEN** 一个 image scene 存在多个接近候选，且启发式排序无法给出高置信度结果
- **THEN** 系统允许为该 scene 调用 LLM judge
- **THEN** 该 judge 调用必须使用配置内的更快模型、并发上限与超时预算

#### Scenario: judge 超预算时回退到确定性选择
- **WHEN** judge 调用超时、被并发限流延迟过久或返回无效结果
- **THEN** 系统不得无限等待该 judge 完成
- **THEN** 系统必须回退到 heuristic top candidate 或该 scene 的非图片 visual

### Requirement: Materialized preview assets SHALL be lightweight, bounded, and local
系统在为 preview 落地 scene 素材时 SHALL 以“可快速导入的本地 preview asset”为目标，而不是默认保存远程原始素材。下载、类型、大小与写入流程 MUST 受显式预算与 guardrails 约束。

#### Scenario: 超重或不适合的远程资源被拒绝或降级
- **WHEN** 候选资源为大 GIF、超大图片、未知类型资源，或其 `content-length`、下载时长超出配置预算
- **THEN** 系统拒绝直接将该资源作为 preview asset 落地
- **THEN** 系统必须改用轻量化版本、静态替代版本，或回退到该 scene 的非图片 visual

#### Scenario: 通过校验的资源以本地 preview asset 形式落地
- **WHEN** 候选资源通过类型、大小与时长校验
- **THEN** 系统将其 materialize 为可被 Remotion 直接 import 的本地 preview asset
- **THEN** 后续 scene code 与 export 继续只消费该本地资产，而不是远程 URL

### Requirement: Scene asset enrichment SHALL emit per-scene substep timing for validation
系统 SHALL 为 `scene asset enrichment` 提供最小可用的子步骤耗时观测，以便验证 selective routing、bounded judge 与 lightweight materialize 是否真正降低 preview 关键路径时延。

#### Scenario: 每个 image scene 记录搜索与判图耗时
- **WHEN** 一个 scene 进入 asset enrichment 链路
- **THEN** 系统记录该 scene 的 `intent`、`searchMs`、`judgeMs`、候选数量与最终选择状态
- **THEN** 这些字段足以区分“慢在搜索”还是“慢在 judge”

#### Scenario: materialize 阶段记录下载与写入重量
- **WHEN** 系统为某个 scene materialize 本地素材
- **THEN** 系统记录 `downloadMs`、`writeMs`、`contentType`、`fileSizeBytes`、来源 host 与最终状态
- **THEN** 这些字段足以识别由大 GIF、超大图片或慢速远程源造成的拖尾
