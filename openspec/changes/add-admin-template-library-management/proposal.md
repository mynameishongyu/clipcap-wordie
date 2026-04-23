## Why

当前性能优化版本已经具备离线模板候选抽取与正式模板库底层能力，但候选数据仍停留在 runtime 本地 JSON 中，没有共享持久化、没有管理员可视化审核入口，也没有清晰定义审核通过后的模板如何被线上 scene 级路由命中。现在需要把“候选生成 -> 人工审核 -> 正式入库 -> 线上命中 -> 禁用/回滚”补成完整闭环，否则离线模板库无法真正投入运营。

## What Changes

- 新增管理员可视化模板库管理能力，在管理员登录后提供独立页面查看候选模板、正式模板与版本历史。
- 将模板候选池与正式模板库从 runtime 本地 JSON 提升为共享持久化存储，支持多实例读取、审核、状态变更与审计。
- 在候选模板中引入可审核的预览信息、来源 run/scene 信息、结构化特征与审核状态，支持管理员逐条审批、拒绝、禁用与备注。
- 明确模板匹配规则为 `scene-level matching`，而不是整条视频模板命中；线上仅允许 `approved` 的 scene template 参与 router 命中。
- 将离线特征填充拆分为确定性结构抽取与可选模型增强两段，人工审核只判断候选 scene 是否具备复用价值，不负责手工填写低层结构字段。
- 为正式模板库补充版本化快照、启停、回滚与管理台操作入口，确保低质量模板可以快速下线。

## Capabilities

### New Capabilities
- `scene-template-library`: 覆盖模板候选共享存储、管理员审核管理、正式模板库生命周期，以及 approved scene template 的线上 scene 级命中规则。

### Modified Capabilities
- 无

## Impact

- Affected code:
  - `src/app/(authenticated)/(admin)/**`
  - `src/app/api/admin/**`
  - `src/app/api/types/admin.ts`
  - `src/config/menu-config.ts`
  - `src/lib/workspace/sceneTemplateLibrary.ts`
  - 新增模板库 repository / persistence 层
  - `src/lib/capabilities/remotion/generatePreview.ts`
- Affected systems:
  - 管理员后台导航与页面
  - 离线模板候选抽取后的持久化链路
  - 线上 render 的 scene router / template matching
- Dependencies:
  - 复用现有管理员权限模型与 Supabase admin 能力
  - 需要新增共享持久化表或等价的可审计存储结构
