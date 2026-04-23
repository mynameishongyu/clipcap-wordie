## Context

当前 project conversation 在用户发送请求后，会立刻在前端插入一个本地 pending assistant 气泡，但文案固定为 `Preparing creative brief...`。与此同时，后端工作流实际上已经通过 `currentStep`、`workflow_steps.message` 和 run 状态写入了多个明确阶段，例如脚本生成、TTS、storyboard、render，以及更长耗时的最终导出。

这导致系统内部“知道自己正在做什么”，但用户界面只展示一个静态等待态。问题不在于缺少日志，而在于缺少一个从运行状态到用户可读提示的 presentation layer。这个变更是跨前端会话 UI、API 类型、repository snapshot 构建以及工作流阶段消息的一次收口设计，因此需要在实现前先统一数据契约和职责边界。

本次范围明确限定为第一层动态进度提示：

- 继续使用现有轮询，不引入 SSE
- 不新增多条 assistant 进度消息
- 不把 `asset search` 升级为新的 pipeline step
- 但底层进度结构必须能支撑未来第二层“会话内进度流”

## Goals / Non-Goals

**Goals:**

- 为运行中的 project conversation task 提供结构化进度提示数据，而不是让前端硬编码静态等待文案。
- 让 pending assistant 气泡能够随工作流阶段变化而更新，覆盖脚本、TTS、storyboard、render 等主阶段。
- 对已知长耗时阶段提供明确 ETA，至少支持最终导出阶段显示“预计 3-5 分钟”。
- 保持 `asset search` 作为 `render` 阶段内部的子阶段提示，不修改现有 pipeline step 集合。
- 为未来第二层会话进度流预留兼容接口，使同一份进度数据可以被“替换当前气泡”或“追加进度消息”两种展示方式复用。

**Non-Goals:**

- 实现真实 token streaming、SSE 推送或 WebSocket 服务端推送。
- 在这次变更中新增 `assistant_progress` 时间线项或一串新的会话消息。
- 重构 `goal-to-storyboard` / `script-confirmed-to-video` / `export-video` 的工作流编排。
- 引入新的 `asset_search` pipeline step 或更改工作流状态机。
- 为每个内部子动作都暴露可见节点；本次只覆盖用户能理解的阶段级提示。

## Decisions

### 1. 引入独立的 progress hint 契约，而不是把显示逻辑塞进 `activeTask`

本次会在 project conversation snapshot / mutation result 中新增独立的进度提示对象，用来表达“当前用户应该看到什么阶段提示”。它与 `activeTask` 分离，后者仍然只负责任务身份和任务状态。

独立 progress hint 至少需要表达：

- 绑定到哪个 `taskId`
- 当前阶段的稳定标识，例如 `goal_script`、`tts`、`storyboard`、`render`、`export`
- 用户可读主文案
- 可选 ETA 文案
- 来源 step 和更新时间，便于后续做增量更新或追加消息

这样设计的原因是，本次第一层只需要替换一个 pending assistant 气泡，但未来第二层会希望把同一份进度数据渲染成多条阶段消息。如果现在把所有文案逻辑塞进 `activeTask.status` 或前端局部状态，后续会再次拆解。

Alternatives considered:

- 把文案直接塞进 `activeTask.prompt` 或 `activeTask.status`。
  Rejected，因为任务实体和展示态会耦合，后续无法稳定扩展到多条进度消息。
- 完全不改 API，只让前端根据 `currentStep` 自己拼文案。
  Rejected，因为 repository 已经掌握 workflow 状态、step message 和更完整的上下文，前端重复推断会造成逻辑分叉。

### 2. 由 repository 统一做阶段归一化和用户文案映射

阶段提示的来源会是现有 run / step 数据，但不会直接把原始 step message 透传给前端。repository 层负责把底层状态归一化成面向用户的阶段提示对象。

归一化规则包括：

- `script` 阶段显示“正在确认目标并生成口播脚本...”一类提示
- `tts` 阶段显示“正在生成配音与时间戳...”
- `storyboard` 阶段显示“正在拆解分镜内容...”
- `render` 阶段显示“正在搜索参考图片并生成预览...”或等价提示
- `export` 阶段显示“正在导出视频，预计 3-5 分钟...”

其中 `asset search` 继续作为 `render` 的内部子阶段，通过 render 阶段文案或 step message 细分来表达，但不新增正式 step。这样可以满足用户看到“正在搜索图片”的感知，又避免修改 pipeline step schema、数据库映射和恢复逻辑。

Alternatives considered:

- 直接透传原始 step message。
  Rejected，因为内部日志语气、细节和稳定性不适合作为最终用户文案，且未来更改日志会意外破坏 UI。
- 把 `asset search` 升级为独立 step。
  Rejected，因为本次目标是改善等待体验，不是扩展工作流状态机；改动面过大。

### 3. 前端本次只更新单个 pending assistant 气泡，不追加新 timeline 项

ProjectConversationProvider 将继续保留“用户消息 + assistant 占位”这组本地 pending feed item，但 assistant 那一项不再使用固定字符串，而是优先读取 mutation result / snapshot 中的 progress hint。

更新策略：

- 发送消息后，如果 mutation result 已返回 progress hint，立即用该文案填充 pending assistant
- 后续轮询 snapshot 时，如果同一 `taskId` 的 progress hint 发生阶段变化，则更新当前 pending assistant 文案
- 当真实 timeline 项足够替代 pending 态，或任务结束 / 等待确认 / 失败 / 取消时，移除 pending assistant

本次不新增 timeline 项，避免在没有明确去重和更新语义前，先把会话流刷成一串“正在处理中”的消息。

Alternatives considered:

- 每次阶段变化都 append 一条新的 assistant 消息。
  Rejected，因为这已经进入第二层能力，需要稳定的消息更新策略和去重规则，不适合和本次一起落地。

### 4. ETA 采用阶段级静态预期，而不是伪精确百分比

本次 ETA 不尝试计算百分比，也不承诺精确剩余时间。系统只在已知长耗时阶段展示用户可理解的预期文本：

- 预览生成阶段使用“通常需要几十秒”或等价短时预期
- 最终导出阶段使用“预计 3-5 分钟”

如果后续需要更细粒度的等待安抚，可以在同一 progress hint 结构上叠加基于 elapsed time 的第二层文案切换，而不改变 API 形状。

Alternatives considered:

- 基于 elapsed time 动态计算百分比进度。
  Rejected，因为底层工作流没有稳定的百分比语义，给出伪精确进度会误导用户。
- 完全不展示 ETA。
  Rejected，因为长阶段没有时间预期时，等待焦虑不会明显改善。

### 5. 保持现有轮询链路，先补 presentation layer

当前前端已经以 2.5 秒轮询 snapshot，并能在任务运行期间持续刷新 `timeline` 和 `taskNotices`。因此这次不新增传输层，只补足 progress hint 的读取与展示即可。

这意味着第一层落地后，用户体验会变成：

- 发送消息后立刻看到阶段提示
- 阶段变化时文案更新
- 长阶段获得 ETA

而不是等待真实流式协议或新的推送基础设施准备完毕。

Alternatives considered:

- 先做 SSE / WebSocket 服务端推送，再做文案层。
  Rejected，因为它延长了关键路径，且不能直接解决当前“没有结构化阶段提示”的根问题。

## Risks / Trade-offs

- [阶段归一化不稳定，前端文案频繁抖动] → 只基于有限的稳定 phase 集合做映射，避免直接依赖任意日志字符串。
- [pending assistant 与真实 timeline 项并存时出现重复文案] → 以 `taskId` 绑定 pending 项，并在 snapshot 出现可替代的真实数据或任务结束时清理本地 pending 状态。
- [把 export ETA 写死为 3-5 分钟后与真实时长不一致] → 文案明确为预估范围，不展示精确倒计时；若偏差过大，可单独调优提示词而不改接口。
- [为未来第二层预留字段导致本次实现稍显超前] → 仅保留最小必要结构，不提前实现多消息渲染逻辑，控制复杂度。
- [render 阶段既包含图片搜索又包含预览生成，提示过于宽泛] → 使用“搜索参考图片并生成预览”这类组合文案，先解决等待感知问题；以后再按子阶段细化。

## Migration Plan

1. 在 project conversation 的 API 类型与 repository snapshot 中加入 progress hint 契约。
2. 在 repository 中基于 `currentStep`、step `message`、运行耗时生成 progress hint，并为初始任务创建结果返回首个阶段提示。
3. 在前端 pending assistant 渲染中消费 progress hint，替换固定的 `Preparing creative brief...` 文案。
4. 对运行中阶段完成联调，覆盖 start-from-request、direct-script continuation、retry continuation 以及长阶段导出提示。
5. 如需回滚，删除 progress hint 字段与前端映射逻辑，恢复静态 pending assistant 文案，不影响现有工作流执行。

## Open Questions

- `export` 阶段是否已经完整进入同一份 project conversation snapshot，还是需要在导出轮询接口上补同构的 progress hint 字段；实现时需要根据现有 UI 链路确认。
- `render` 阶段的子文案是否只用稳定组合提示，还是在已有 step message 足够稳定时进一步区分“搜索图片”和“打包预览工程”；本次可以先采用保守组合提示。
