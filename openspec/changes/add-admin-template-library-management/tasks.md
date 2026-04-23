## 1. 共享持久化与数据模型

- [ ] 1.1 设计并落地共享持久化 schema，覆盖 `scene_template_candidates`、`scene_template_library_entries` 与 `scene_template_library_versions`
- [ ] 1.2 新增模板库 repository / persistence 层，封装候选创建、分页查询、审批、禁用、版本快照与回滚操作
- [ ] 1.3 将现有 `sceneTemplateLibrary.ts` 的领域逻辑改造成可同时服务 Trigger runtime 与 web admin 的共享模块
- [ ] 1.4 保留本地 JSON 作为开发 fallback 或迁移辅助，不再作为正式模板库的权威数据源

## 2. 离线候选生成与特征填充

- [ ] 2.1 将 preview 成功后的候选追加逻辑从本地 JSON 写入改为共享候选池写入
- [ ] 2.2 扩展候选 schema，补充管理员审核所需的来源信息、审核状态、审计字段与可审核预览信息
- [ ] 2.3 实现确定性结构特征抽取，自动填充 `kind`、`slots`、`constraints`、`layoutPreset`、`motionPreset` 等字段
- [ ] 2.4 设计并接入可选的离线模型增强流程，用于补充语义标签、复用提示或质量提示
- [ ] 2.5 确保模型增强失败不会阻塞候选入池，并为缺失增强信息的候选提供明确状态

## 3. 管理员页面与 API

- [ ] 3.1 在 admin 导航中新增 `Template Library` 入口，并复用现有 `(authenticated)/(admin)` 权限模式
- [ ] 3.2 新增模板库管理页面，展示候选模板列表、正式模板列表与版本历史
- [ ] 3.3 为候选列表补充筛选、分页、状态展示与来源 `project/run/scene` 信息
- [ ] 3.4 新增 `/api/admin/template-candidates`、`/api/admin/template-library` 与回滚相关 API
- [ ] 3.5 实现管理员审批动作：`approve`、`reject`、`disable`、`rollback` 与审核备注
- [ ] 3.6 扩展 `src/app/api/types/admin.ts`，补齐模板候选、正式模板和版本记录的类型与 schema

## 4. 线上命中与 router 契约

- [ ] 4.1 将线上模板读取从本地 JSON 切换为共享正式模板库读取
- [ ] 4.2 明确并实现 `scene-level matching`，确保每个 storyboard scene 独立进行模板路由
- [ ] 4.3 实现 `kind` 推断、硬约束过滤、兼容度评分与阈值 gating，且仅允许 `approved` 模板参与匹配
- [ ] 4.4 确保未命中、被禁用、被拒绝或不兼容模板都能稳定回退到自由 scene TSX 路径
- [ ] 4.5 使管理员禁用与版本回滚结果对线上模板读取立即生效

## 5. 迁移、回滚与验证

- [ ] 5.1 提供从本地 JSON 到共享存储的迁移脚本或迁移步骤，覆盖候选池与正式模板库
- [ ] 5.2 验证候选生成、管理员审核、批准入库、禁用和回滚的完整闭环
- [ ] 5.3 验证非管理员无法访问模板管理页面与相关 API
- [ ] 5.4 验证线上请求只会命中 `approved` 模板，且 scene 级匹配与自由回退共存稳定
- [ ] 5.5 输出 rollout 与 rollback 说明，明确共享存储切换、admin 页面启用、模板匹配启停与离线模型增强开关策略
