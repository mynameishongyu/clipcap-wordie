## ADDED Requirements

### Requirement: Project conversation requests SHALL evaluate whether external research is required before goal and script generation
系统在处理 `start_from_request` 类型的项目对话消息时，必须在生成 creative goal 与 voiceover script 之前判断当前请求是否需要外部研究。该判断必须同时覆盖显式最新信息需求和可能有时效性的现代实体、公司、组织、人物、战争、冲突、政策、产品或模型名称，而不能只依赖“最新”一类显式关键词。

#### Scenario: 显式最新事件请求触发研究
- **WHEN** 用户发送“介绍伊朗战争的最新情况”这类明确要求最新信息的请求
- **THEN** 系统将该请求标记为必须执行外部研究
- **THEN** 系统在 goal 与 script 生成前先执行文本研究

#### Scenario: 现代公司介绍在无时效词时也触发研究
- **WHEN** 用户发送“介绍一下新华联合冶金控股集团”这类未显式写出“最新”但主题属于现代公司的请求
- **THEN** 系统将该请求识别为可能依赖最新外部信息
- **THEN** 系统在 goal 与 script 生成前执行文本研究

#### Scenario: Evergreen 常识主题不强制研究
- **WHEN** 用户发送稳定性较高的常识型主题，且系统未识别出明显现代实体或时效性依赖
- **THEN** 系统可以跳过外部研究
- **THEN** 系统继续现有 goal 与 script 生成流程

### Requirement: Required research SHALL use Tavily text search and produce reusable source documents
当研究判定要求执行外部研究时，系统必须使用 Tavily 文本搜索获取相关网页结果，并将结果规范化为可复用的 source documents 与 `sourceContext`。这些研究来源必须可被后续 workflow、日志与 timeline 复用，而不是仅作为临时 UI 展示结果。

#### Scenario: Tavily 研究结果被规范化为 source documents
- **WHEN** 系统对一个需要研究的请求执行 Tavily 文本搜索
- **THEN** 系统保存每条可用结果的来源 URL、标题、站点信息与文本摘要或正文片段
- **THEN** 系统基于这些结果构建可传入 workflow 的 `sourceContext`

#### Scenario: 用户自带 URL 与 Tavily 研究结果合并
- **WHEN** 用户消息同时包含可抓取 URL，且研究判定也要求执行 Tavily 文本搜索
- **THEN** 系统将 URL 抓取结果与 Tavily 文本研究结果合并为统一来源集合
- **THEN** 合并后的来源集合用于后续 goal 与 script 生成

### Requirement: Goal and script generation SHALL consume the researched source context
当研究阶段产出了可用 `sourceContext` 时，系统必须将该上下文同时传入 creative goal 生成与 voiceover script 生成。脚本生成不得忽略已经获得的研究来源。

#### Scenario: Creative goal 使用研究来源
- **WHEN** 系统已为当前请求生成研究来源与 `sourceContext`
- **THEN** creative goal 生成阶段接收到该 `sourceContext`
- **THEN** 生成出的 creative brief 反映研究得到的主题信息与上下文

#### Scenario: Voiceover script 使用研究来源
- **WHEN** 系统已为当前请求生成研究来源与 `sourceContext`
- **THEN** voiceover script 生成阶段接收到该 `sourceContext`
- **THEN** 最终脚本以研究来源为依据，而不是仅依赖模型已有知识

### Requirement: Required research failures SHALL block grounded script generation
当系统判定当前请求必须依赖最新外部信息时，如果 Tavily 文本搜索未能得到任何可形成有效 `sourceContext` 的研究来源，系统不得继续生成看似基于最新信息的脚本。系统必须显式报告研究失败，并要求用户稍后重试或提供可访问来源。

#### Scenario: 必需研究无结果时阻止脚本生成
- **WHEN** 当前请求被标记为必须研究
- **WHEN** Tavily 文本搜索未返回任何可用文本来源
- **THEN** 系统不继续生成 creative goal 或 voiceover script
- **THEN** 系统向用户返回明确的研究失败信息

### Requirement: Conversation timeline SHALL distinguish research sources from scene asset search
系统必须在 conversation timeline 与 preview 中区分“脚本前研究来源”和“storyboard 后 scene asset search”。用户应能明确看到哪些来源被用于 goal/script，哪些结果仅用于图片与画面参考。

#### Scenario: 文本研究结果显示为独立 research 工具项
- **WHEN** 系统在脚本前执行了 Tavily 文本研究
- **THEN** timeline 中显示独立的 research 工具项
- **THEN** 该工具项展示研究 query、链接与摘要，并表明其已用于脚本生成

#### Scenario: Scene image search 继续独立表示画面搜索
- **WHEN** storyboard 之后执行 scene image search
- **THEN** timeline 中的 scene image search 结果仍单独表示为画面参考搜索
- **THEN** 用户不会将其误解为脚本文本研究来源

### Requirement: Script retries SHALL reuse the previously researched source context
当同一个 run 在 script 阶段被重试时，系统必须复用该 run 首次生成时保存的研究来源与 `sourceContext`。重试逻辑不得因为只读取 turn 级临时字段而丢失首次研究上下文。

#### Scenario: Script retry 保留首次研究来源
- **WHEN** 一个已经执行过研究的 run 在 script 阶段被重试
- **THEN** 重试流程读取该 run 持久化的研究来源与 `sourceContext`
- **THEN** 重试后的 script 生成继续基于首次研究结果
