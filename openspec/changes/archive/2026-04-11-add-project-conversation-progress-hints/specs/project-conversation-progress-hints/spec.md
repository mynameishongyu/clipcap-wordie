## ADDED Requirements

### Requirement: 运行中任务必须暴露结构化进度提示
系统 MUST 为 project conversation 中处于运行态的任务暴露结构化 progress hint，并将其作为独立于 `activeTask` 的展示数据返回。该 progress hint SHALL 至少包含任务绑定关系、稳定阶段标识、用户可读主文案，以及可选 ETA 信息，以便相同数据既能驱动当前的单气泡替换，也能在后续驱动会话内进度流。

#### Scenario: Snapshot 返回运行中任务的进度提示
- **WHEN** 某个项目存在 `running` 状态的 active task，且其 workflow run 已写入 `currentStep` 或当前 step message
- **THEN** `ProjectConversationSnapshot` MUST 返回与该 `taskId` 绑定的 progress hint
- **THEN** 该 progress hint MUST 独立于 `activeTask` 存在，而不是把展示文案混入任务状态字段

#### Scenario: 初始发送结果立即返回首个进度提示
- **WHEN** 用户发送消息并成功创建新的运行中任务
- **THEN** `ProjectConversationMutationResult` MUST 在返回 active task 的同时返回首个 progress hint
- **THEN** 该首个 progress hint MUST 可直接替代静态 waiting 文案，无需前端再次推断阶段

### Requirement: 系统必须将工作流状态归一化为稳定的用户阶段
系统 SHALL 将底层 workflow step、step message 和运行上下文归一化为有限且稳定的用户阶段集合，而不是直接暴露内部日志。阶段集合 MUST 至少覆盖脚本确认/生成、TTS、storyboard、render 和 export。

#### Scenario: 脚本阶段显示面向用户的阶段提示
- **WHEN** 当前运行位于 `script` 阶段
- **THEN** 系统 MUST 返回表达“确认目标并生成口播脚本”语义的 progress hint
- **THEN** 系统 MUST NOT 直接把内部 logger 文案原样作为最终用户提示返回

#### Scenario: Render 阶段包含图片搜索语义但不新增 step
- **WHEN** 当前运行进入 `render` 阶段，且该阶段内部包含图片搜索或预览生成动作
- **THEN** 系统 MUST 返回包含“搜索参考图片”和/或“生成预览”语义的 progress hint
- **THEN** 系统 MUST NOT 为此引入新的正式 pipeline step 作为本次需求前提

### Requirement: 前端必须用 progress hint 动态更新 pending assistant
前端 MUST 使用 progress hint 渲染发送消息后的 pending assistant 气泡，并在同一 `taskId` 的阶段发生变化时更新该气泡文案，而不是始终显示固定的 `Preparing creative brief...`。

#### Scenario: 发送后立即显示动态阶段提示
- **WHEN** 用户发送消息且 mutation result 中已包含 progress hint
- **THEN** pending assistant 气泡 MUST 显示该 progress hint 的主文案
- **THEN** 前端 MUST NOT 回退到固定的 `Preparing creative brief...`，除非 progress hint 缺失

#### Scenario: 轮询后阶段变化更新当前气泡
- **WHEN** 前端轮询到同一 `taskId` 的 progress hint 已切换到新阶段
- **THEN** 前端 MUST 更新当前 pending assistant 气泡文案
- **THEN** 前端 MUST NOT 因阶段变化而额外追加一条新的 assistant timeline 项

### Requirement: 长耗时阶段必须提供明确等待预期
对于已知长耗时阶段，系统 SHALL 返回明确的等待预期文案，帮助用户建立时间感知。其中最终导出阶段 MUST 提供“预计 3-5 分钟”或等价范围提示；预览相关阶段 MUST 使用较短预期，避免与最终导出混淆。

#### Scenario: 导出阶段展示 3-5 分钟预期
- **WHEN** 当前 progress hint 对应最终导出阶段
- **THEN** 返回的 progress hint MUST 包含“预计 3-5 分钟”或等价 ETA 文案

#### Scenario: 预览阶段不误导为最终导出
- **WHEN** 当前 progress hint 对应 render 或预览生成阶段
- **THEN** 返回的 progress hint MUST 使用短时等待预期或不带长 ETA
- **THEN** 系统 MUST NOT 将该阶段描述为需要 3-5 分钟的最终导出
