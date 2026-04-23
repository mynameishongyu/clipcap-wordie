## ADDED Requirements

### Requirement: User-provided URL requests SHALL extract sources before generation
系统处理 `start_from_request` 消息时，如果用户消息包含可规范化 URL，MUST 在 creative goal 与 voiceover script 生成前执行 URL extraction。成功抓取到的 URL source documents MUST 被保存为当前 turn/run 可复用的 `sourceDocumentsJson` 与 `sourceContext`，并传入后续 goal/script 生成流程。

#### Scenario: 单个用户 URL 被解析为来源上下文
- **WHEN** 用户发送包含可访问 URL 的视频制作请求
- **THEN** 系统在生成 creative goal 前抓取该 URL 的可读内容
- **THEN** 系统保存该 URL 对应的 source document
- **THEN** 系统将基于该 source document 构建的 `sourceContext` 传给 creative goal 与 script 生成

#### Scenario: URL 抓取完全失败时不继续伪造来源脚本
- **WHEN** 用户消息包含 URL
- **WHEN** URL extraction 未能得到任何可用 source document
- **THEN** 系统不得继续生成看似基于该网页内容的 creative goal 或 voiceover script
- **THEN** 系统必须返回明确错误，要求用户提供可访问链接、粘贴正文或稍后重试

### Requirement: Source-grounded requests SHALL preserve creative brief confirmation
当用户请求明确要求基于网页、文章、URL 或外部来源内容制作视频时，系统 MUST 在解析来源后生成可确认的 creative brief，并在用户确认前不得把该请求视为已确认脚本。系统 MUST NOT 因快速启动或后台 bootstrap 优化而把 source-grounded request 的 goal version 直接标记为 confirmed 并继续 post-script 生产。

#### Scenario: 基于网页内容的请求生成待确认 brief
- **WHEN** 用户请求基于某个网页或文章内容制作视频
- **WHEN** 系统已完成来源解析并生成 creative brief
- **THEN** 系统将该 creative brief 暴露为待确认状态
- **THEN** 系统在用户确认前不启动依赖已确认 brief/script 的后续生产阶段

#### Scenario: Source-grounded request 不写入 confirmed script
- **WHEN** 用户消息是 URL/source-grounded production request，而不是最终口播脚本
- **THEN** 系统不得写入项目级 `confirmedScriptToolId`
- **THEN** 系统不得把用户原始请求写作已确认 `scriptText`
- **THEN** 系统必须等待 request-generation 流程生成并确认后续内容

### Requirement: Source research timeline SHALL reflect user URL grounding
当用户提供 URL 并且系统成功解析其内容时，conversation timeline MUST 展示该 URL 来源属于脚本前研究来源，而不是把它混入 storyboard 后的 scene asset search。该展示 MUST 能让用户确认脚本和 brief 是否基于正确来源。

#### Scenario: 用户 URL 显示为 research 工具项
- **WHEN** URL extraction 为当前 request 产生了 source documents
- **THEN** timeline 中显示 research 工具项或等价来源展示
- **THEN** 该项包含来源链接、标题或摘要
- **THEN** 用户能够区分这些来源已用于 goal/script，而不是仅用于视觉素材搜索
