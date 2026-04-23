## Context

当前项目的 project conversation 工作流已经天然存在一个适合插入音色选择的阶段：run 在 script 生成后会进入 `WAITING_SCRIPT_CONFIRM`，随后才继续执行 `tts -> storyboard -> render`。前端也已经具备音色菜单、音色试听和 `selectedVoiceId` 提交通道，但后端尚未把该选择真正传入 Volcengine TTS；真实执行仍然只读取单一的 `VOLCENGINE_TTS_SPEAKER`。

这意味着当前系统处于“交互形态领先于后端契约”的状态：

- 前端已经暗示用户可以切换音色
- API 已能接收 `selectedVoiceId`
- pipeline step payload 已开始记录 `selectedVoiceId`
- 真正的 TTS 请求仍然绑定单一 speaker

本 change 需要把这些分散片段收敛为一个闭环能力，并保持当前 workflow 的成本控制目标不变。核心产品约束已经明确：

- 音色选择应放在开始阶段，即 script 确认之后、TTS 之前
- 首发只提供两种默认音色
- 用户必须能先试听再选择
- “成片后再改音色”不作为本次首发目标

## Goals / Non-Goals

**Goals:**

- 在 `WAITING_SCRIPT_CONFIRM` 阶段提供稳定、真实可用的音色试听与选择能力。
- 用一个受控的双音色 catalog 驱动前端展示、默认值和后端 speaker 映射。
- 在用户确认 script 时，把本次音色选择一并锁定到 run 中，并驱动后续 TTS 执行。
- 保证选中的音色对 TTS、storyboard 和 preview 结果真正生效，而不是只改变前端展示。
- 在 catalog 缺失、音色失效或客户端提交非法音色时，提供可预期的校验与回退行为。

**Non-Goals:**

- 不在本次 change 中支持任意数量的火山音色浏览、搜索或后台动态拉取全量官方音色列表。
- 不在本次 change 中支持“成片后即时切换音色且无需重生成”。
- 不在本次 change 中引入新的后台管理页面来维护音色 catalog。
- 不在本次 change 中为每个脚本动态生成专属试听 sample。

## Decisions

### 1. 音色选择固定落在 script 确认门槛前

决策：

- 用户只能在 script 预览/确认界面选择音色。
- 只有在 transcript 与 voice 都确定后，系统才进入 TTS。

原因：

- 当前 workflow 本来就以 `WAITING_SCRIPT_CONFIRM` 作为人工确认门槛，将音色放在这里最符合现有状态机。
- 一旦音色变化，旁白节奏、时长与 timestamps 都可能变化；后续 storyboard 对齐和 render 不应基于未确认音色提前启动。
- 将音色选择后置到 preview 之后，会把“改音色”变成一次新的重生成请求，成本和复杂度都显著更高。

备选方案：

- 在成片后允许直接切换音色。
  - 放弃原因：不符合当前 pipeline 的 timing 依赖关系，也不符合本次“省成本”的产品目标。

### 2. 首发使用本地受控的双音色 catalog，而不是实时查询官方音色库

决策：

- 系统维护一个应用侧的 voice catalog，首发仅启用两个音色。
- 每个 catalog 项至少包含：
  - `id`
  - `name`
  - `description`
  - `audioUrl`
  - `volcengineSpeaker`
  - `isDefault` 或等价排序信息

原因：

- 当前产品只需要两个精选音色，不需要把火山引擎的全部 speaker 暴露给终端用户。
- 本地 catalog 更稳定，便于策划控制展示名、描述、试听 sample 和默认顺序。
- 这可以避免把“查询火山全量音色列表”变成用户路径依赖。

备选方案：

- 每次从火山官方接口实时拉取音色列表。
  - 放弃原因：增加外部依赖、鉴权复杂度和 catalog 漂移风险，也超出首发目标。

### 3. 音色选择以 run 为边界持久化

决策：

- 本次选中的 `selectedVoiceId` 作为 run 级输入持久化，而不是仅保存在前端状态。
- script 确认 step、run metadata，以及后续 TTS step 输出都应能追溯本次音色选择。

原因：

- 一旦进入 TTS，后端、Trigger workflow、重试与历史回放都需要知道本次 run 用的是哪个音色。
- 只有 run 级持久化，后续 retry、export、历史快照和调试日志才能保持一致。

备选方案：

- 只保存在前端确认请求里，不写入 run。
  - 放弃原因：一旦重试或回放，就无法稳定恢复真实执行音色。

### 4. TTS 执行优先读取 run 选中的 voice，而不是单一全局 speaker

决策：

- Volcengine TTS 在执行时优先使用本次 run 绑定的 `selectedVoiceId -> volcengineSpeaker` 映射。
- 仅当用户未显式选择音色时，系统才回退到 catalog 主默认音色。
- 若客户端提交的 `selectedVoiceId` 不存在于当前 catalog，确认请求必须报错，而不是静默降级到别的音色。

原因：

- “用户选了什么，就合成什么”是该能力的核心语义，不能靠单一环境变量继续兜底。
- 对缺失选择做主默认回退可以保证老 run 或兼容路径可继续执行。
- 对非法选择显式报错可以避免 UI / backend catalog 漂移被静默吞掉。

备选方案：

- 所有异常都静默回退到默认音色。
  - 放弃原因：会掩盖真实配置问题，也会让用户以为选择生效但实际未生效。

### 5. 试听 sample 使用静态或预生成音频，不走在线 TTS

决策：

- 音色试听使用 catalog 自带的 `audioUrl`，不在用户点试听时实时调用 TTS。

原因：

- 试听是探索动作，不应触发 TTS 成本，也不应影响 workflow 时延。
- 首发只有两个音色，使用预生成 sample 成本最低、稳定性最高。

备选方案：

- 用当前 transcript 实时生成每个音色的试听。
  - 放弃原因：增加成本、时延和失败面，且不符合“前置省成本”的目标。

### 6. “成片后改音色”明确作为后续独立能力

决策：

- 本次 change 不支持成片后直接切换音色。
- 若未来需要支持，应定义为“基于既有 transcript 发起一次新的 TTS/storyboard/render 变体生成”。

原因：

- 当前 storyboard 与 preview 强依赖 TTS timestamps，后置换音色本质上不是改一个字段，而是开一条新生成链路。
- 先把前置选择闭环做稳，比把后置变体能力一起塞进首发更可控。

## Risks / Trade-offs

- [试听 sample 与真实脚本合成风格存在感知差异] → Mitigation：使用同一 speaker 录制 sample，并在文案中强调“试听为示例音色”而非逐字预览。
- [catalog 中的 speaker 与火山真实可用 speaker 漂移] → Mitigation：将 speaker 映射集中管理，并在确认阶段与 TTS 阶段都做显式校验与日志记录。
- [老 run 或旧前端请求不带 `selectedVoiceId`] → Mitigation：保留主默认音色回退路径，确保兼容已有确认流程。
- [仅提供两个音色导致部分用户觉得可选性不足] → Mitigation：首发以成本和落地稳定性优先，后续再通过 catalog 扩展更多精选音色。
- [未来要做“后置改音色”时与本次 run 语义冲突] → Mitigation：在本次设计中明确 run 级音色绑定，后续把“改音色”建模为新 run 或新 variant。

## Migration Plan

1. 准备双音色 catalog，并为两个音色补齐展示文案、试听 sample 与 speaker 映射。
2. 在 script 确认路径中启用 catalog 校验与默认音色回退逻辑。
3. 让 TTS 执行优先读取 run 绑定音色；保留单一环境变量作为兼容 fallback，而不是主路径。
4. 在预发布环境验证：
   - 两个默认音色都能试听
   - 两个默认音色都能真实触发不同 speaker 的 TTS
   - 未带 `selectedVoiceId` 的旧路径仍能用默认音色执行
5. 生产发布时先保持 catalog 仅两项，避免需求扩散。

回滚策略：

- 若音色 catalog 或 speaker 映射出现问题，可临时隐藏多音色选择 UI，并强制所有确认请求回到主默认音色。
- 若后端执行不稳定，可保留 `selectedVoiceId` 持久化，但让 TTS 暂时继续读取单一默认 speaker，以恢复现有稳定路径。

## Open Questions

- 第二个默认音色具体选择哪个 speaker，偏“温和讲解”还是“更有力量感的播报”？
- 是否要在后续迭代里记住用户上一次所选音色，作为同一 project 的默认值？
- 试听 sample 是否需要区分中英文场景，还是首发只提供中文 sample 即可？
