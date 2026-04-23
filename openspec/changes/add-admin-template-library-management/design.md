## Context

当前仓库已经具备离线模板候选抽取、正式模板库启停/回滚、以及 `open_template` 控制的线上模板加速基础能力，但这些能力仍存在三个缺口：

1. 模板候选与正式模板库当前默认落在 `process.cwd()/.localdata/remotion-template-library`，而候选抽取运行在 Trigger runtime，管理员页面运行在 Next.js web 进程，两者并不共享稳定的 `cwd` 与持久化边界。
2. 管理员没有可视化页面查看候选集合、审核候选 scene、批准入库、禁用模板或执行版本回滚。
3. 虽然线上已有模板加速路径，但“审核通过的模板到底如何被线上命中使用”还没有被正式定义；必须先明确匹配粒度、审核对象和特征填充方式，才能让 admin 审核具有实际意义。

现有约束：

- 管理员能力已存在统一入口，复用 `(authenticated)/(admin)` layout、Supabase admin auth、`/api/admin/*` route 模式最自然。
- 候选模板并非整条视频模板，而是从成功 `scene` 中抽取出来的 `scene candidate`。
- 离线模板候选生成不能阻塞 `preview ready` 主链。
- 现有 `sceneTemplateLibrary.ts` 已有 candidate/library schema 和 promote/disable/rollback 基础函数，但数据源仍是本地 JSON。

## Goals / Non-Goals

**Goals:**

- 将模板候选池与正式模板库迁移到共享持久化存储，供 Trigger runtime 和 web admin 页面共同访问。
- 为管理员提供一个可视化模板库管理页面，查看候选模板、审核并批准入库、拒绝、禁用与回滚。
- 明确审核粒度为 `scene candidate`，而不是视频级模板或更细碎的 fragment。
- 明确线上匹配规则为 `scene-level matching`：对 storyboard 中每个 scene 独立判型、过滤、评分、命中或回退。
- 将离线特征填充拆为：
  - 确定性结构抽取
  - 可选模型语义增强
- 让管理员审核聚焦“是否具备复用价值”，而不是手工填写低层结构字段。
- 为正式模板库保留版本快照、启停和回滚入口，支持低质量模板快速下线。

**Non-Goals:**

- 不在本 change 中重做整个模板渲染引擎，只补齐候选管理与线上命中契约。
- 不要求第一版实现复杂的可视化编辑器；管理员以审核、批准、禁用和回滚为主。
- 不要求第一版支持自动无审核入库。
- 不要求第一版引入向量检索或复杂 embedding 检索；优先使用结构化特征 + 规则评分完成 scene 匹配。

## Decisions

### 1. 使用共享持久化存储作为模板库权威数据源

决策：

- 新增共享持久化表，保存：
  - `scene_template_candidates`
  - `scene_template_library_entries`
  - `scene_template_library_versions`
- Trigger runtime 在 preview 成功后将候选写入共享存储。
- web admin 页面只读取共享存储，不直接读取 runtime 本地 JSON。
- 本地 JSON 仅保留为开发 fallback 或临时导出，不再作为权威数据源。

原因：

- 当前候选写入 `.localdata` 依赖 `cwd`，在 web 和 Trigger 之间不可共享。
- admin 页面需要稳定分页、筛选、审核和审计；本地 JSON 不适合作为长期后台数据源。
- 线上 router 未来也需要稳定读取正式模板集合，共享存储是更自然的权威来源。

备选方案：

- 继续使用 `.localdata/remotion-template-library/*.json` 作为管理台数据源。
  - 放弃原因：运行环境不稳定，不适合多实例和运营后台。

### 2. 审核粒度固定为 `scene candidate`

决策：

- 每条候选记录对应一个成功 scene 抽出的 `scene template candidate`。
- 管理员审核对象是这个 `scene candidate`，而不是整条视频，也不是更细的 fragment。

原因：

- 线上模板命中本来就是 scene 级；离线审核也必须和线上粒度一致。
- scene 是最小可复用视觉结构单位，既能保留上下文，又不会过度耦合整条视频。

备选方案：

- 以整条视频模板为审核单位。
  - 放弃原因：命中率低、复用性差、会迫使不适合模板化的 scene 也进入模板路径。

### 3. 人工审核只判断“是否值得复用”，结构字段由系统自动填充

决策：

- 管理员审核动作只包括：
  - `approve`
  - `reject`
  - `disable`
  - `rollback`
  - 可选审核备注
- 管理员不需要手工填写低层结构字段。
- 候选创建时，系统自动填充确定性结构特征：
  - `kind`
  - `lineCount`
  - `hasImage`
  - `maxLines`
  - `requiresImage`
  - `layoutPreset`
  - `motionPreset`
  - 来源 `project/run/scene`

原因：

- 人工审核应聚焦“这是不是一个值得沉淀的 scene template”，而不是做数据录入。
- 这些结构化字段程序可稳定推导，人工重复填写没有价值。

备选方案：

- 让管理员在审核时手工标注模板特征。
  - 放弃原因：成本高、易漂移、会显著降低模板库增长效率。

### 4. 离线特征增强分为确定性抽取和可选模型增强两段

决策：

- Stage A：确定性抽取
  - 从成功 scene 中提取基础结构特征并创建 candidate
- Stage B：可选模型增强
  - 由离线模型补充语义标签、复用提示、质量提示或更细的 scene kind 建议
- 模型增强失败不会阻塞 candidate 入池；只会减少审核辅助信息。

原因：

- 并非所有候选都需要模型参与；很多结构字段可以直接从 scene 文本与 visual mode 推导。
- 模型更适合做语义归类和复用潜力提示，而不是承担所有结构抽取。

备选方案：

- 所有候选完全依赖模型抽取特征。
  - 放弃原因：成本更高，且不必要地增加离线复杂度。

### 5. 线上模板匹配固定为 `scene-level matching`

决策：

- 线上请求不会先尝试匹配“整套视频模板”。
- 对 storyboard 中每个 scene 独立进行匹配：
  1. 推断 `scene kind`
  2. 用硬约束过滤 `approved` 模板
  3. 按结构/布局/运动/ratio 兼容度打分
  4. 分数高于阈值时命中模板
  5. 否则回退到自由 scene TSX

原因：

- 一条视频通常由不同类型 scene 组成，整条视频级模板命中会显著降低命中率。
- scene 粒度更符合现有 render 编排，也更利于模板库逐步增长。

备选方案：

- 先匹配整条视频级模板家族，再统一套用。
  - 放弃原因：适配面过窄，对长尾场景不稳。

### 6. 只有 `approved` 模板参与线上命中

决策：

- candidate 状态至少包含：
  - `candidate`
  - `approved`
  - `rejected`
  - `disabled`
- 线上 router 只能读取 `approved` 且未禁用的模板集合。
- 被 `disabled` 的模板不得继续参与匹配。

原因：

- 候选池是待审核集合，不能直接影响线上行为。
- `disabled` 与 `rollback` 是快速止损手段，必须对线上读取立即生效。

备选方案：

- 候选自动参与线上尝试。
  - 放弃原因：风险过高，会把未验证模板直接暴露给用户。

### 7. 管理台采用现有 admin shell 模式实现

决策：

- 页面挂在 `(authenticated)/(admin)` 下，新增 `Template Library` 导航项。
- 使用现有模式：
  - server page 拉初始数据
  - client component 做列表、筛选、审批动作
  - `/api/admin/*` 提供审核和库管理操作

原因：

- 现有邀请码管理、会员积分管理已经建立了稳定的 admin UI/API 模式。
- 模板库管理本质上也是后台运营能力，复用现有模式成本最低。

备选方案：

- 单独起独立后台应用。
  - 放弃原因：当前 scope 过重，与现有 admin 能力割裂。

## Risks / Trade-offs

- [共享存储迁移复杂度增加] → 先保持 `sceneTemplateLibrary.ts` 作为领域逻辑层，新增 repository 适配 Supabase，避免在 UI 和 Trigger 两侧散落逻辑。
- [候选预览信息不足，审核体验不够“可视化”] → 第一版至少保存来源 run/scene、voiceover 摘要与预览引用；如无法生成独立 thumbnail，也要提供来源 project/run 入口。
- [模型增强结果不稳定] → 只把模型增强作为审核辅助信息，不作为唯一结构特征来源，也不作为线上匹配的单一依据。
- [模板匹配误命中导致视觉退化] → 采用硬约束 + 分数阈值 + 自由生成回退；仅让 `approved` 模板参与匹配。
- [管理员操作影响线上结果] → 每次批准、禁用、回滚都写版本快照与审计字段，支持快速回退。

## Migration Plan

1. 新增共享持久化 schema，用于保存 candidate、library entry 与 version snapshot。
2. 将当前 preview 成功后的 candidate append 逻辑改为写共享存储，并保留开关控制。
3. 新增 admin API 与页面，先实现候选列表、批准、拒绝、禁用、回滚。
4. 将线上模板读取从本地 JSON 切到共享正式模板库。
5. 保留本地 JSON 逻辑作为短期 fallback，验证稳定后降级为开发辅助。

回滚策略：

- UI 回滚：移除 admin 导航入口，关闭模板管理页面。
- 数据层回滚：切回本地 JSON 读取路径或关闭共享模板读取。
- 线上匹配回滚：关闭 `open_template` 或让 router 忽略共享模板库，仅走自由生成。
- 离线候选回滚：关闭候选写入开关，停止新增 candidate。

## Open Questions

- 第一版候选审核页是否必须展示独立 scene thumbnail，还是允许先展示来源 run/scene 的预览入口。
- 共享存储是否直接使用现有 Supabase 表，还是先通过 JSON snapshot 字段降低 schema 复杂度。
- 是否在第一版就引入“审核备注 + 审核人 + 审核时间”的完整审计 UI，还是先保留字段、后补操作体验。
