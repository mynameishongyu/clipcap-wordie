## Context

当前 `project conversation` 的 `start_from_request` 路径会先提取用户消息中的 URL，并在可用时通过 Firecrawl 抓取正文，然后把 `sourceContext` 传给 creative goal 与 script 生成。这个机制只覆盖“用户主动提供来源”的场景，无法覆盖“用户只给出一个现代实体或时效性主题，但没有贴 URL”的请求。与此同时，仓库里已经接入了 Tavily，但现阶段仅用于 storyboard 之后的 scene image search，产生的 `search` timeline item 也混合了文本来源与图片来源，容易让用户误判这些结果都参与了脚本生成。

这次变更是跨越 message orchestration、workflow payload、prompt input、timeline 表达和第三方搜索依赖的交叉改动。设计目标不是替换现有 URL 抓取，而是在它之前补上一层“研究判定 + Tavily 文本研究”，并将研究结果复用现有 `sourceContext` 通道送入 `goal -> script`。同时，需要把“脚本前研究”和“分镜后搜图”在产品语义上拆开，避免继续沿用一个含义模糊的 `search` 卡片。

## Goals / Non-Goals

**Goals:**
- 在 `start_from_request` 工作流开始前增加研究判定，识别是否需要检索最新外部信息。
- 让显式最新需求和可能有时效性的现代实体都能触发 Tavily 文本搜索，而不依赖用户必须写出“最新”或自行贴 URL。
- 将 Tavily 文本搜索结果规范化为可复用的 source documents，并注入 creative goal 与 voiceover script 生成。
- 在研究被判定为必需但没有拿到可用来源时，阻止系统伪装成“有依据地生成最新脚本”。
- 将脚本前研究结果与 storyboard 后的 scene image search 在 timeline / preview 语义上分离。
- 为研究判定、查询构建、研究结果数量、来源注入情况提供可追踪日志。

**Non-Goals:**
- 替换现有 Firecrawl URL 抓取能力；用户显式贴链接时仍然继续支持。
- 重写 `goal-to-storyboard`、`script-confirmed-to-video`、TTS、storyboard 或 render 的核心执行链。
- 做通用新闻聚合器或复杂的多轮研究代理。
- 解决所有事实核验问题；本变更聚焦“在明显需要最新外部信息时，先搜再写”。

## Decisions

### 1. 在 `start_from_request` 中增加独立的 research decision 阶段

在进入 `generateGoalVersion()` 之前，repository 层新增一个 research decision 步骤。该步骤使用模型输出结构化 JSON，例如：

- `shouldSearch`
- `freshnessMode`：`required | preferred | none`
- `reason`
- `entityCandidates`
- `searchQueries`

判定输入至少包括：

- 当前用户消息
- 最近用户消息历史
- 已存在的 `sourceContext`
- 语言与 aspect ratio 等现有上下文

判定规则以模型为主、偏保守执行：只要输入涉及现代公司、组织、人物、战争、冲突、政策、产品、模型版本、市场动态等容易过时的主题，即使用户没有写“最新”，也应返回 `shouldSearch = true`。显式“最新/目前/现状/最近”需求则应返回 `freshnessMode = required`。

Alternatives considered:
- 仅靠时效关键词触发搜索。
  Rejected，因为像“新华联合冶金控股集团”这类公司介绍往往不包含显式时效词，但依然依赖最新外部信息。
- 仅靠规则枚举公司/人物/战争类关键词。
  Rejected，因为维护成本高，且对中英文混输、别名、长尾实体覆盖不稳定。

### 2. 用 Tavily 直接承担文本研究，并把结果规范化为 source documents

新增 Tavily 文本搜索封装，和现有 `searchSceneImagesWithTavily()` 并列，但服务于脚本前研究。该封装负责：

- 接收 research decision 产出的搜索 query 列表
- 在 `freshnessMode = required` 时优先使用适合最新信息检索的 Tavily 参数
- 返回归一化后的 research documents，至少包含 `url`、`title`、`siteName`、`summary/snippet`、`raw content excerpt`、`fetchedAt`

这些 research documents 将复用现有 `UrlSourceDocument` / `buildSourceContext()` 通道，而不是另起一套 prompt 拼装逻辑。若用户消息里本来就有 URL，则最终 source documents 由两部分合并而成：

- 用户显式 URL 抓取结果（Firecrawl）
- Tavily 文本研究结果

Alternatives considered:
- Tavily 仅返回链接，再逐条交给 Firecrawl 二次抓取。
  Rejected，因为会增加网络链路与失败面，且对“先快速拿到最新摘要进入脚本”不是必须。
- 让 Tavily 直接生成答案摘要，不保留来源文档。
  Rejected，因为系统已经围绕 `sourceContext` 和 source documents 组织上下文，丢掉来源结构会削弱可观察性与可复用性。

### 3. `freshnessMode = required` 且无可用研究来源时，停止生成而不是静默回退到旧知识

当 research decision 判断本次请求必须依赖最新外部信息，而 Tavily 未返回任何可用文本结果，或所有结果都无法形成有效 `sourceContext` 时，系统不得继续生成一个看起来像“最新解读”的脚本。此时应：

- 记录明确的 research failure 日志
- 将 run 标记为失败并返回用户可理解的错误，例如要求稍后重试或提供可访问来源

对于 `freshnessMode = preferred` 的场景，可以记录告警并继续，但必须在日志中标出最终脚本未使用外部研究来源。

Alternatives considered:
- 无论搜索是否成功都继续生成。
  Rejected，因为这会把“先搜再写”退化成装饰性动作，无法满足最新信息内容的可信度要求。

### 4. 为脚本前研究新增独立的 conversation tool 语义

不再让同一个 `search` tool item 同时承载“脚本研究来源”和“分镜图片搜索”。设计上新增独立的 `research` timeline / preview 语义：

- `research`：脚本前来源研究，展示 query、链接、摘要，并明确标注其已用于 goal/script
- `search`：storyboard/render 阶段的 scene asset search，继续展示图片与画面参考

这样可以让时间线顺序与真实工作流一致，也能避免用户把 scene image search 误认为脚本文本研究。

Alternatives considered:
- 保留 `search` tool_name，只在卡片文案上提示“有些结果只用于画面”。
  Rejected，因为数据来源与时间顺序已经不同，继续共用一个语义会让实现和用户理解都持续混乱。

### 5. 重试与后续回放必须复用首次研究结果

首次 `start_from_request` 成功得到的合并 source documents 与 `sourceContext`，应以 run 级别持久化作为脚本阶段真实输入源，而不是仅依赖 turn 上的即时字段。后续发生 script retry 或历史回放时，应优先读取 run 上的研究来源，避免丢失首次研究得到的上下文。

Alternatives considered:
- 继续沿用 `turn.sourceContext` 做 script retry 输入。
  Rejected，因为当前 turn 仅保存当次 URL 抓取结果，不包含合并后的历史研究上下文，重试时会丢来源。

## Risks / Trade-offs

- [研究判定过于激进，导致额外 Tavily 调用增加] → 通过日志统计命中率与 query 质量，先采用偏保守但可观测的策略，后续再调阈值。
- [Tavily 返回摘要过短，导致 `sourceContext` 质量不足] → 优先请求更丰富的文本字段，并在归一化时保留尽可能多的原始片段。
- [显式最新请求因为 Tavily 无结果而频繁失败] → 将失败信息明确暴露给用户，并支持用户追加 URL 或稍后重试，而不是输出伪装成最新的脚本。
- [新增 `research` tool 语义扩大前端改动面] → 限制在 project conversation timeline / preview 范围内变更，不波及其他工具卡。
- [两套 Tavily 用途混淆实现职责] → 在模块命名与类型上严格区分 `text research` 与 `scene image search`，避免复用同一个结果结构。

## Migration Plan

1. 在 repository 层加入 research decision 与 Tavily text research，但先复用现有 `sourceContext` 注入链路。
2. 将 run 级 source documents / `sourceContext` 作为脚本阶段的权威来源，修正 retry 时的来源读取逻辑。
3. 新增 `research` timeline / preview 类型，并保持现有 `search` 只表示 scene image search。
4. 以开发环境样例验证：
   - 显式最新事件请求
   - 无显式时效词的现代公司介绍
   - 纯常识型 evergreen 主题
   - Tavily 无结果或失败场景
   - script retry / 历史回放场景
5. 回滚方案：移除 research decision 与 Tavily text research 调用，恢复仅 URL 抓取 + scene image search 的现状；前端回退到单一 `search` tool 展示。

## Open Questions

- Tavily 文本搜索是否需要持久化额外的来源元数据，例如发布时间、score、query 命中原因，以支持后续调优与 UI 展示？
- `freshnessMode = preferred` 的继续生成场景，是否需要在用户可见 timeline 中标注“本次脚本未检索到外部最新来源”？
