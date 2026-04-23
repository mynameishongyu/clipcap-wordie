## Context

当前 `project conversation` 在消息入口先执行 intent routing，再决定进入 `start_from_request`、`start_from_direct_script`、retry 或 HITL confirm。问题样例中，用户输入包含 `https://www.globaltimes.cn/page/202604/1358956.shtml` 和明确制作要求，但 `looksLikeFullScript()` 因 URL 内部点号与整体长度把它识别成完整脚本，随后直接触发 `workspace-script-confirmed-to-video-workflow`。

这导致三个后果：

- URL extraction/source research 没有执行，`sourceDocumentsJson` 与 `sourceContext` 为空。
- 原始 URL 请求被作为 `scriptText` 写入 run，并把 `script` step 标记为 `DONE`。
- 项目级 `confirmedScriptToolId` 被更新，用户看到的是脚本已确认后的后续 workflow，而不是基于网页内容的 brief 对齐流程。

现有相关模块：

- `src/lib/workspace/projectConversationIntent.ts`: intent heuristic 与模型兜底。
- `src/lib/data/project-conversations-repository.ts`: 各 intent 的初始化、持久化和 workflow trigger。
- `src/lib/workspace/sourceExtraction.ts`: URL 提取与规范化。
- `src/lib/workspace/firecrawl.ts`、`src/lib/workspace/tavily.ts`: 外部来源获取。

## Goals / Non-Goals

**Goals:**

- 防止 URL/source-grounded 制作请求被误判为完整脚本。
- 保留真正“用户直接粘贴最终脚本”的快速路径。
- 确保带 URL 的制作请求进入 `start_from_request`，并执行 URL extraction/source research。
- 对基于网页/文章内容的请求保留 creative brief 确认语义，避免解析后立即继续生产。
- 增加覆盖该 bug 的回归测试，验证路由、持久化状态与 workflow trigger 类型。

**Non-Goals:**

- 不重写整个 intent classifier 或引入新的模型服务。
- 不替换 Firecrawl/Tavily。
- 不改变 retry、等待脚本确认 HITL、direct script 成功路径的外部 API 形态。
- 不修复本次暴露出的 storyboard alignment 失败；那是误路由后的下游症状。

## Decisions

### 1. 在 full script 判定前识别 source-grounded request

决策：

- 在 intent heuristic 中加入显式 URL/request 信号识别。
- 当消息包含可规范化 `http(s)://` URL，并同时包含制作动词或引用网页内容的语义时，优先返回 `start_from_request`。
- 该规则应先于 `!waitingTask && fullScript` 执行。

原因：

- URL 制作请求的用户意图是“请基于这个来源生成视频”，不是“这里是一份最终脚本”。
- 当前 full script heuristic 是宽松启发式，不能覆盖 URL 这类高风险结构化文本。

备选方案：

- 仅调高 `looksLikeFullScript()` 长度阈值。
  - 放弃原因：不能从语义上区分 URL 请求和长脚本，仍可能被 URL 标点或长说明误导。
- 完全交给模型 classifier。
  - 放弃原因：会增加延迟和不确定性；URL/request 信号足够明确，适合本地确定性规则。

### 2. full script 计数必须忽略 URL 内部标点

决策：

- `looksLikeFullScript()` 在计算 sentence count 前，应将 URL 替换为空格或稳定占位符。
- URL 归一化逻辑优先复用 `extractReferencedUrls`/`normalizeExtractedUrl` 的语义，避免新增不一致的 URL 解析规则。
- direct script 的 positive signal 应更偏向脚本结构，例如多段文本、明确旁白/镜头/字幕标记、连续自然语言句子，而不是 URL 拆分出来的片段。

原因：

- `www.globaltimes.cn/page/...shtml` 被句子分割正则切成多个片段，是这次误判的直接触发条件。
- 修正计数能降低未来所有含 URL 的误判风险，而不仅是 Global Times 这个例子。

备选方案：

- 修改全局 `countSentences()` 分句正则。
  - 放弃原因：其他调用点可能依赖当前粗粒度句子计数；本次风险集中在 full script 识别，可局部修正。

### 3. direct script 初始化增加防御性校验

决策：

- 即使 intent 已经是 `start_from_direct_script`，`initializeDirectScriptMessage()` 也应拒绝明显 source-grounded request。
- 被拒绝时应回退到 `start_from_request`，而不是报错给用户。

原因：

- intent router 是入口第一道防线，但 direct script 路径会写 `confirmedScriptToolId` 并跳过 source/goal，是高影响路径。
- 双层防御能避免未来模型或启发式改动再次把 URL 请求送入 direct script。

备选方案：

- 只修 router。
  - 放弃原因：缺少防线，未来维护时容易回归。

### 4. URL/source-grounded 请求启用 brief 确认模式

决策：

- `start_from_request` 不再无条件使用 `goalConfirmationMode = 'skipped'`。
- 对包含用户 URL、成功得到 source documents，或请求明确要求“based on this website/article/source”的 turn，应使用 `goalConfirmationMode = 'required'`，让 generated goal 保持 `pending`，并等待用户确认后再启动后续生产。
- 对不依赖外部来源的普通请求，可继续使用现有快速启动策略，避免扩大交互成本。

原因：

- 用户贴 URL 的场景需要确认系统是否正确理解文章来源、范围和重点。
- 性能优化的目标是减少等待，不应牺牲 source-grounded 内容的正确性和用户对齐。

备选方案：

- 所有 `start_from_request` 都恢复确认。
  - 放弃原因：会全面增加一次交互，偏离现有快速启动体验。
- 所有请求继续 skipped，只修 URL 解析。
  - 放弃原因：虽然能基于来源生成，但用户仍无法阻止系统在误读来源后继续生产。

### 5. 测试以 intent + repository 状态为主

决策：

- 增加纯函数/轻量单元测试覆盖 intent routing：
  - URL 制作请求 -> `start_from_request`
  - URL + 长说明不触发 `looksLikeFullScript`
  - 真正多段脚本 -> `start_from_direct_script`
- 增加 repository 层测试或可注入依赖测试覆盖：
  - URL request 不写 `confirmedScriptToolId`
  - URL request 不触发 `WORKSPACE_SCRIPT_CONFIRMED_TO_VIDEO_TASK_ID`
  - source-grounded request 的 goal confirmation mode 为 `required`

原因：

- 这次 bug 是路由和持久化状态组合问题，仅测 UI 不够稳定。
- Trigger/Supabase 全链路测试成本高，核心语义应在低层测试中锁住。

备选方案：

- 只做手动复现。
  - 放弃原因：风险集中在启发式边界，必须有回归测试。

## Risks / Trade-offs

- [Risk] 少数没有明显结构、但足够长的真实脚本可能被路由为 `start_from_request`。→ Mitigation: 保留多段、旁白/镜头/字幕等强脚本信号；测试覆盖常见 direct script 输入。
- [Risk] URL/source-grounded 请求恢复确认会增加一次用户交互。→ Mitigation: 仅对来源依赖场景启用 `required`，普通快速请求继续 `skipped`。
- [Risk] Firecrawl 无法读取来源时，用户会更早看到失败或确认缺失。→ Mitigation: 沿用现有 URL extraction failure blocking 逻辑，并给出可操作错误文案。
- [Risk] 前端 timeline 可能需要处理 `required` brief 与 running placeholder 的组合状态。→ Mitigation: 复用现有 `goalConfirmationMode` 和 goal timeline item，不引入新 UI 协议，必要时只调整文案/状态选择。

## Migration Plan

1. 实现 intent helper 与 URL-aware full script 判定。
2. 在 direct script 初始化入口加入 source-grounded request guard。
3. 为 `start_from_request` 增加条件化 `goalConfirmationMode`，并确保 URL/source-grounded 请求在 goal 生成后保持 pending。
4. 调整继续 workflow 的触发点：`required` brief 不应在用户确认前触发 goal-to-storyboard 后续生产。
5. 增加回归测试并执行 `pnpm typecheck` 与目标 lint/test。
6. 手动复现原始项目输入，确认 payload 不再把 URL 请求作为 `scriptText`。

回滚策略：

- 回滚 intent helper 与 repository guard 后，系统恢复旧 direct script 判定行为。
- 如果确认语义引入阻塞问题，可临时只保留 URL-aware routing，关闭 URL/source-grounded 的 `required` 分支。

## Open Questions

- 是否需要让“source-grounded request 的 brief 确认”支持配置开关，以便在性能优先环境中灰度？
- 用户确认 brief 后是否复用现有 HITL endpoint，还是需要单独的 goal confirmation endpoint？实现前需要确认当前前端是否已有 goal confirmation 操作入口。
