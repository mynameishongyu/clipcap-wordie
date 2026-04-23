## Why

当前工作流只有两类“搜索”能力：用户显式贴 URL 时的正文抓取，以及分镜后的 Tavily 图片搜索。对于“介绍伊朗战争的最新情况”或“介绍一下新华联合冶金控股集团”这类包含现代实体、公司、冲突或政策信息的请求，如果用户没有附带 URL，脚本阶段仍主要依赖模型已有知识，容易生成过时或不完整的口播内容。现在需要把“是否需要最新研究”的判断前置，并把检索到的文本来源真正送入 `goal -> script` 生成链路。

## What Changes

- 在 `project conversation` 的 `start_from_request` 流程中新增“研究判定”步骤，由模型判断当前请求是否涉及可能有时效性的专有名词、现代实体或显式最新信息需求。
- 在命中研究判定时，使用 Tavily 执行文本搜索，检索与用户主题最相关的最新网页结果，并将结果整理为可复用的 source documents 与 `sourceContext`。
- 让研究得到的文本来源同时参与 creative goal 生成与 voiceover script 生成，而不是只停留在 timeline / preview 展示层。
- 保留现有 Tavily 分镜图片搜索能力，明确它属于 storyboard/render 阶段，与脚本前置研究分离。
- 调整 conversation timeline / preview 中的搜索展示语义，区分“脚本研究来源”和“分镜图片搜索”，避免用户误以为所有 search 结果都参与了脚本生成。
- 为研究判定、文本搜索结果、脚本使用来源情况补充日志与调试信息，便于验证“搜到了什么”以及“是否进入脚本提示词”。

## Capabilities

### New Capabilities
- `project-conversation-source-research`: 在项目对话启动工作流前识别需要最新外部信息的请求，执行 Tavily 文本搜索，并将研究结果注入 goal 与 script 生成，同时向用户清晰展示研究来源与用途。

### Modified Capabilities
- None.

## Impact

- Affected API / orchestration entrypoint: `src/app/api/projects/[projectId]/messages/route.ts`, `src/lib/data/project-conversations-repository.ts`
- Affected workflow payload and script-generation inputs: `src/lib/workspace/pipeline.ts`, `trigger/workspace/goalToStoryboard.ts`, `src/lib/workspace/goalConfirmation.ts`, `src/lib/capabilities/script/generateScript.ts`
- Affected source ingestion layer: `src/lib/workspace/sourceExtraction.ts`, new Tavily text-search integration under `src/lib/workspace/`
- Affected preview / timeline semantics for search artifacts in project conversation UI
- Dependency impact: Tavily will be used in two distinct workflow phases, one for text research and one for scene image search
