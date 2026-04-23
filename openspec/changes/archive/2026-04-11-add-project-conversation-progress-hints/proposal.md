## Why

当前项目会话在工作流执行期间只显示静态的 `Preparing creative brief...` 占位文案，即使后端已经进入“确认目标”“生成口播脚本”“生成配音”“拆解分镜”“生成预览”“导出视频”等不同阶段，用户侧也看不到变化。这会放大长耗时节点的等待焦虑，尤其是在包含大模型、素材搜索和最终导出的视频流程里。

这次变更需要先补齐第一层动态进度提示能力，在不引入真实 SSE 或多条会话流式消息的前提下，让前端基于现有轮询和 step 状态展示阶段性反馈；同时保留后续演进到第二层“会话内进度流”的兼容接口，避免这次实现把显示逻辑写死在单一文案上。

## What Changes

- 为 project conversation 增加结构化“运行中进度提示”能力，进度来源于现有 workflow `currentStep`、step `status`、step `message` 与运行耗时，而不是静态占位文案。
- 将前端发送消息后的 pending assistant 气泡从固定文本改为动态阶段提示，随着轮询到的运行状态变化而更新。
- 建立用户可读的阶段文案映射，覆盖至少以下阶段：确认目标/生成口播脚本、生成配音与时间戳、拆解分镜、搜索参考图片并生成预览、导出视频。
- 对长耗时阶段补充 ETA 文案，至少在最终导出阶段明确提示“预计 3-5 分钟”；预览阶段使用更短的等待预期，不混淆为最终导出。
- 保持 `asset search` 作为 `render` 阶段内部的子阶段提示，不把它升级为新的正式 pipeline step。
- 在 API / domain 层增加可扩展的进度展示结构，让后续新增“assistant_progress”时间线项或多条阶段消息时可以复用同一份进度数据，不需要重新设计底层契约。
- 保持现有轮询机制与任务状态流转，不引入真实 token streaming、SSE 推送或新的工作流编排节点。

## Capabilities

### New Capabilities
- `project-conversation-progress-hints`: 为项目会话中的运行中任务提供结构化阶段提示、长耗时 ETA 和前端动态展示能力，并为后续会话内进度流预留兼容接口。

### Modified Capabilities
- None.

## Impact

- 受影响前端：`src/app/(authenticated)/project/[projectId]/_components/ProjectConversationProvider.tsx`
- 受影响 API 类型：`src/app/api/types/project-conversation.ts`
- 受影响会话仓储与 snapshot 构建：`src/lib/data/project-conversations-repository.ts`
- 受影响运行状态持久化读取：`src/lib/workspace/sqlite.ts`
- 受影响工作流阶段消息来源：`trigger/workspace/goalToStoryboard.ts`
- 不新增外部依赖，不修改 Trigger 工作流拓扑，不改变现有 retry / HITL / export API 入口
- 回滚方式：移除新的进度提示字段与前端映射，恢复 pending assistant 的静态 `Preparing creative brief...` 文案
