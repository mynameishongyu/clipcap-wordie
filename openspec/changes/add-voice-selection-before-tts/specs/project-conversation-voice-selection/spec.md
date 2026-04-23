## ADDED Requirements

### Requirement: Script 确认阶段必须提供可试听的双音色选择
系统 MUST 在 project conversation 的 script 确认阶段向用户展示一组受控的音色选项。首发版本 MUST 提供两个默认启用的音色，每个音色 MUST 包含稳定的 `id`、展示名、描述和可直接播放的试听 sample。

#### Scenario: 等待 script 确认的任务展示两个默认音色
- **WHEN** 某个 run 进入 `WAITING_SCRIPT_CONFIRM`，且用户打开 script 预览面板
- **THEN** 系统 MUST 返回两个默认启用的音色选项
- **THEN** 每个音色选项 MUST 包含 `id`、`name`、`description` 和 `audioUrl`

#### Scenario: 试听音色不触发生产工作流
- **WHEN** 用户在 script 确认阶段点击任一音色的试听按钮
- **THEN** 客户端 MUST 直接播放该音色的 sample 音频
- **THEN** 系统 MUST NOT 因试听动作启动新的 TTS、storyboard 或 render 执行

### Requirement: Script 确认请求必须绑定本次 run 的音色选择
当用户确认 transcript 时，系统 SHALL 将本次选择的音色作为 run 级输入一并提交和持久化。后续 TTS、storyboard 与 preview 生成 MUST 基于该音色执行，而不是继续固定使用单一全局 speaker。

#### Scenario: 用户确认时提交有效音色
- **WHEN** 用户在 script 确认阶段提交 transcript，并携带有效的 `selectedVoiceId`
- **THEN** 系统 MUST 接受该音色选择，并将其写入当前 run 的持久化状态
- **THEN** 后续 TTS 执行 MUST 使用该 `selectedVoiceId` 对应的 speaker 进行合成

#### Scenario: 旧路径未显式传音色时使用主默认音色
- **WHEN** script 确认请求未携带 `selectedVoiceId`
- **THEN** 系统 MUST 为该 run 解析并绑定主默认音色
- **THEN** 后续 TTS 执行 MUST 使用主默认音色，而不是因字段缺失直接失败

### Requirement: 系统必须校验音色选择并提供稳定回退
系统 MUST 只接受来自当前有效 voice catalog 的音色选择。对于非法音色、已下线音色或历史 run 中失效的音色，系统 SHALL 提供可预期的校验或回退行为，而不是静默使用未知 speaker。

#### Scenario: 客户端提交非法音色标识
- **WHEN** script 确认请求携带的 `selectedVoiceId` 不存在于当前有效 voice catalog
- **THEN** 系统 MUST 拒绝该确认请求
- **THEN** 系统 MUST 返回可诊断的错误，而不是静默替换为其他音色

#### Scenario: 历史选中音色已不再可用
- **WHEN** 某个历史 run 或 UI 初始状态引用的 `selectedVoiceId` 已不在当前有效 voice catalog 中
- **THEN** 客户端 MUST 回退到当前主默认音色作为展示和确认默认值
- **THEN** 系统 MUST 仍允许用户在当前 catalog 中重新选择并继续确认
