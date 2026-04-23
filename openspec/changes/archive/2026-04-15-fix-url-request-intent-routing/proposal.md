## Why

用户发送包含 URL 的视频制作请求时，当前 intent router 可能把 URL 中的点号拆成多个句子，误判为完整脚本并直接进入 `start_from_direct_script`。这会绕过 URL extraction、source research 与 creative brief 对齐，导致系统把原始 URL 请求当作已确认脚本继续执行。

## What Changes

- 收紧 `start_from_direct_script` 判定，避免仅因 URL、长度或句子数量就把制作请求当作完整脚本。
- 让包含可识别 URL 且带有制作意图的消息优先路由为 `start_from_request`，进入 URL extraction/source research/goal generation 流程。
- 在 full script 识别前对 URL 做规范化处理，URL 内部标点不得贡献脚本句子数。
- 为 URL/source-grounded 请求增加确认语义：当用户要求“基于这个网页/文章内容制作视频”时，系统必须先基于解析来源生成 creative brief，并在继续生产前保留可确认状态，除非请求明确提供的是最终脚本。
- 增加覆盖 URL 请求误路由、direct script 正常路由、source research/confirmation 状态的回归测试。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `project-conversation-intent-routing`: 明确包含 URL 的制作请求不得被 URL 标点或长度误判为 `start_from_direct_script`，应优先进入 `start_from_request`。
- `project-conversation-source-research`: 明确用户提供 URL/source-grounded 请求时必须完成来源解析并保留 creative brief 确认语义，不能在无来源上下文时继续生成脚本。

## Impact

- 影响代码：
  - `src/lib/workspace/projectConversationIntent.ts`
  - `src/lib/data/project-conversations-repository.ts`
  - 相关 API 类型、timeline/progress 显示逻辑视实现需要调整
- 影响流程：
  - `start_from_direct_script` 只处理真正的最终脚本。
  - `start_from_request` 负责含 URL 的制作请求，并触发 URL extraction/source research。
  - URL/source-grounded 请求的 creative brief 状态需要可被用户确认或至少不被误标为直接脚本确认。
- 影响外部依赖：
  - 继续使用现有 Firecrawl/Tavily，不新增依赖。
- 风险：
  - 过度收紧 direct script 判定可能让少数无结构但较长的脚本被路由到 request flow。
  - 恢复确认语义可能增加一次用户交互，影响性能优化后的快速启动体验。
- 回滚方案：
  - 回滚 intent 判定改动即可恢复旧路由行为。
  - 若确认语义影响过大，可通过配置或条件判断仅对 URL/source-grounded 请求启用。
- 验证：
  - 单元测试覆盖 URL 制作请求应路由 `start_from_request`。
  - 单元测试覆盖真实完整脚本仍可路由 `start_from_direct_script`。
  - 集成测试或 repository 测试验证 URL 请求不会写入 `confirmedScriptToolId`，且会进入 source extraction/goal confirmation 路径。
