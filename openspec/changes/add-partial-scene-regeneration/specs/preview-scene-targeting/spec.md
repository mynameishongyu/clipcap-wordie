## ADDED Requirements

### Requirement: Video preview SHALL expose scene timeline metadata
系统 SHALL 在成功的视频预览数据中返回有序的 scene 时间线元数据，使客户端能够把当前帧稳定映射回 storyboard scene。该元数据 MUST 至少包含 `sceneId`、顺序索引、时间范围、帧范围和该 scene 的旁白文本摘要。

#### Scenario: Successful preview includes scene timeline
- **WHEN** 项目会话或预览 API 返回一个可播放的 Remotion 视频预览
- **THEN** 对应的 `video` artifact MUST 包含完整且有序的 scene 时间线元数据
- **THEN** 每个 scene 条目 MUST 能唯一标识回原始 storyboard scene

#### Scenario: Preview falls back to plain video file
- **WHEN** 任务只有导出视频或旧版 preview，而没有可用的 Remotion scene timeline
- **THEN** 系统 MUST 明确标记当前预览不支持 scene targeting
- **THEN** 客户端 MUST 不展示“修改这一段”的可提交入口

### Requirement: Paused preview SHALL resolve the current editable scene
系统 SHALL 在预览暂停时解析当前帧所属的 scene，并将其作为用户发起局部修改的默认目标。未解析到 scene 或预览未暂停时，系统 MUST 阻止隐式提交，避免把含糊的“这一段”错误绑定到其它片段。

#### Scenario: User pauses preview on a valid scene
- **WHEN** 用户暂停在一个带 scene timeline 的 Remotion 预览上
- **THEN** 客户端 MUST 能解析并展示当前 scene 的标识与时间范围
- **THEN** 用户提交的修改说明 MUST 绑定到该 scene 的结构化标识

#### Scenario: Preview is still playing
- **WHEN** 用户尚未暂停预览就尝试发起“修改这一段”
- **THEN** 客户端 MUST 要求先暂停或显式选择目标 scene
- **THEN** 系统 MUST 不在缺少确定 `sceneId` 的情况下创建局部重生成任务

### Requirement: Scene revision requests SHALL carry explicit scene context
系统 SHALL 通过结构化消息上下文传递 scene revision 请求，而不是仅依赖自然语言推断目标片段。该上下文 MUST 至少包含 `baseRunId`、`sceneId` 和触发来源，以保证后端能够确定性地执行局部重生成。

#### Scenario: Scene revision is submitted from preview UI
- **WHEN** 用户在预览里输入对当前片段的修改说明并提交
- **THEN** project conversation 消息请求 MUST 附带结构化 scene revision 上下文
- **THEN** 后端 MUST 优先使用该结构化上下文，而不是让意图分类器猜测目标 scene

#### Scenario: Structured scene context is invalid
- **WHEN** 请求中的 `baseRunId`、`sceneId` 或来源预览与当前项目不匹配
- **THEN** 系统 MUST 拒绝创建局部重生成任务
- **THEN** 客户端 MUST 收到可操作的错误信息，而不是进入运行态
