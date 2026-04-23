## ADDED Requirements

### Requirement: System SHALL regenerate only the targeted scene
系统 SHALL 支持基于一个已有成功预览的结果，只重生成被指定的单个 scene，而不重新生成其它 scene。目标 scene 的生成输入 MUST 复用原始 storyboard scene、素材 grounding 和共享设计上下文，除非后续显式扩展为可选重搜模式。

#### Scenario: Regenerate one scene from a successful preview
- **WHEN** 用户针对某个成功预览中的 `sceneId` 提交局部修改请求
- **THEN** 系统 MUST 仅重写该 scene 对应的 Remotion scene 源文件
- **THEN** 系统 MUST 不重新生成未命中的其它 scene 代码

#### Scenario: Base preview is not eligible for partial regeneration
- **WHEN** 目标 run 缺少可恢复的 Remotion project、storyboard 或 scene timeline
- **THEN** 系统 MUST 拒绝局部重生成请求
- **THEN** 系统 MUST 明确说明该预览当前只能整体重试，不能做单 scene 返工

### Requirement: Scene regeneration MUST preserve audio and timing
局部 scene 重生成 MUST 保持原始配音、时间戳、scene 时长和整体 timeline 不变。系统 MUST 使用原有音频与 Root scene timeline 重新构建 preview bundle，而不是重新推导时长或调整其它 scene 的起止位置。

#### Scenario: Scene visual changes but duration stays fixed
- **WHEN** 目标 scene 完成局部重生成
- **THEN** 该 scene 的 `start_s`、`end_s`、`duration_s` 和帧范围 MUST 与源预览保持一致
- **THEN** 整体视频的总时长与配音内容 MUST 与源预览保持一致

#### Scenario: User asks for a change that implies longer or shorter timing
- **WHEN** 用户的修改说明暗示要延长、缩短或重写旁白节奏
- **THEN** 系统 MUST 仍按原始时长约束该 scene 的重生成
- **THEN** 如有必要，系统 MUST 明确提示这次局部修改不会改变音频和时长

### Requirement: Partial regeneration SHALL publish a new preview version safely
局部重生成成功后，系统 SHALL 产出新的预览版本并将其作为最新结果展示，同时保留源预览作为可回退的历史版本。局部重生成失败时，系统 MUST 保留源预览可继续查看、导出或再次发起其它修改。

#### Scenario: Partial regeneration succeeds
- **WHEN** 单 scene 重生成与 preview bundle 重建成功
- **THEN** 系统 MUST 生成一个新的预览结果并在项目会话中展示为最新 `video` artifact
- **THEN** 源预览版本 MUST 仍然可被追溯，而不是被破坏性覆盖

#### Scenario: Partial regeneration fails
- **WHEN** 目标 scene 代码生成、校验或 bundle 构建失败
- **THEN** 系统 MUST 不破坏源预览的可播放状态
- **THEN** 用户 MUST 能继续基于原预览进行查看、导出或再次修改
