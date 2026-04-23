## ADDED Requirements

### Requirement: Template candidates MUST be persisted in shared storage for admin review
系统 MUST 将离线抽取出的 `scene template candidate` 保存到共享持久化存储中，供 Trigger runtime 和管理员后台共同读取。系统不得仅依赖 runtime 本地 JSON 作为模板候选的权威数据源。

#### Scenario: Preview 成功后候选进入共享候选池
- **WHEN** 一个 workflow run 成功生成 preview，并启用了模板候选抽取
- **THEN** 系统 MUST 将该 run 中抽取出的 `scene template candidate` 写入共享候选池
- **THEN** 管理员页面随后能够读取到该候选集合

#### Scenario: Web admin 页面不直接依赖 runtime 本地 JSON
- **WHEN** 管理员打开模板库管理页面
- **THEN** 页面 MUST 从共享持久化存储读取候选和正式模板数据
- **THEN** 页面不得要求直接访问 Trigger runtime 的本地 `.localdata` 文件

### Requirement: Admins MUST be able to review scene candidates visually and manage library states
系统 MUST 为管理员提供模板库管理页面，用于查看候选模板、审核、批准入库、拒绝、禁用和回滚正式模板库版本。该页面 MUST 仅对管理员账户开放。

#### Scenario: 管理员查看候选模板列表
- **WHEN** 管理员进入模板库管理页面
- **THEN** 系统 MUST 展示候选模板列表
- **THEN** 每条候选 MUST 至少包含来源 `project/run/scene`、`kind`、核心结构特征、审核状态与可审核的预览信息

#### Scenario: 非管理员无法访问模板库管理页面
- **WHEN** 非管理员用户访问模板库管理入口或对应 API
- **THEN** 系统 MUST 拒绝访问
- **THEN** 系统 MUST 不暴露候选模板或正式模板库数据

#### Scenario: 管理员批准候选模板入库
- **WHEN** 管理员在候选模板列表中执行 `approve`
- **THEN** 系统 MUST 将该候选提升为正式模板库中的 `approved` entry
- **THEN** 系统 MUST 记录审核人、审核时间或等价审计信息

#### Scenario: 管理员禁用正式模板
- **WHEN** 管理员对正式模板执行 `disable`
- **THEN** 系统 MUST 将该模板标记为禁用
- **THEN** 被禁用模板 MUST 不再参与线上模板匹配

#### Scenario: 管理员回滚模板库版本
- **WHEN** 管理员选择一个历史模板库版本执行回滚
- **THEN** 系统 MUST 恢复该版本对应的正式模板集合
- **THEN** 系统 MUST 使后续线上匹配读取回滚后的模板状态

### Requirement: Human review MUST happen at scene-candidate granularity
人工审核对象 MUST 是单条 `scene candidate`，而不是整条视频模板，也不是更细碎的 fragment。管理员审核 MUST 聚焦该 scene 是否具备复用价值。

#### Scenario: 候选审核对象是单个 scene
- **WHEN** 系统为一次成功 render 生成模板候选
- **THEN** 每条候选 MUST 对应一个独立 storyboard scene
- **THEN** 管理员审核时看到的单位 MUST 是该单个 scene candidate

#### Scenario: 审核不要求管理员手工填写低层结构字段
- **WHEN** 管理员审核一个候选 scene
- **THEN** 管理员的主要操作 MUST 是 `approve`、`reject`、`disable` 或填写审核备注
- **THEN** 管理员不需要手工录入 `lineCount`、`hasImage`、`layoutPreset` 等低层结构字段

### Requirement: Candidate features MUST be auto-filled before review
系统 MUST 在候选进入审核池前自动填充结构化特征，并允许离线模型增强补充语义标签或复用提示。模型增强 SHOULD 作为辅助信息，而不是唯一结构化来源。

#### Scenario: 系统自动填充确定性结构特征
- **WHEN** 系统从成功 scene 中抽取候选
- **THEN** 候选 MUST 自动包含 `kind`、`slots`、`constraints`、`layoutPreset`、`motionPreset` 及来源信息
- **THEN** 这些字段 MUST 在管理员审核前已经可用

#### Scenario: 模型增强失败不阻塞候选入池
- **WHEN** 离线模型增强无法完成语义标签或复用提示补充
- **THEN** 系统 MUST 仍允许候选进入审核池
- **THEN** 系统 MUST 将模型增强视为辅助信息缺失，而不是候选创建失败

### Requirement: Online template matching MUST happen at scene level using approved templates only
线上模板匹配 MUST 按 `scene-level` 执行，而不是按整条视频模板执行。系统 MUST 仅允许 `approved` 且未禁用的模板参与匹配，并在未命中时回退到自由 scene 路径。

#### Scenario: Storyboard 中每个 scene 独立匹配模板
- **WHEN** 一个线上请求进入 storyboard -> render 阶段，并启用了模板加速
- **THEN** 系统 MUST 对 storyboard 中的每个 scene 独立执行模板匹配
- **THEN** 同一条视频中的不同 scene MAY 命中不同模板或回退到自由生成

#### Scenario: 未审核候选不得参与线上匹配
- **WHEN** 一个候选仍处于 `candidate` 或 `rejected` 状态
- **THEN** 该候选 MUST 不参与线上模板匹配
- **THEN** 线上 router MUST 只读取 `approved` 且未禁用的正式模板

#### Scenario: 模板匹配失败时回退自由 scene 路径
- **WHEN** 某个 scene 在 `kind`、约束或评分阈值上未能命中正式模板
- **THEN** 系统 MUST 回退到自由 scene TSX 路径
- **THEN** 模板未命中不得阻塞该 scene 的生成

### Requirement: Scene matching MUST use kind routing, constraint filtering, and score gating
系统 MUST 先判断 scene 所属的模板类型，再基于硬约束过滤和打分阈值决定是否命中模板。系统不得将所有模板无差别地对所有 scene 进行直接匹配。

#### Scenario: 系统先按 kind 路由
- **WHEN** 一个 scene 准备进入模板匹配
- **THEN** 系统 MUST 先推断该 scene 的 `kind`
- **THEN** 系统 MUST 先筛选同 kind 的正式模板，再进入后续匹配

#### Scenario: 系统按约束过滤不兼容模板
- **WHEN** 某个模板与当前 scene 在 `requiresImage`、`maxLines` 或其他硬约束上不兼容
- **THEN** 系统 MUST 在打分前过滤掉该模板
- **THEN** 不兼容模板 MUST 不得进入最终候选集合

#### Scenario: 系统以评分阈值决定命中
- **WHEN** 多个兼容模板通过约束过滤
- **THEN** 系统 MUST 基于结构、布局、运动、ratio 或等价兼容特征进行评分排序
- **THEN** 仅当最佳模板分数达到阈值时系统才会命中该模板
