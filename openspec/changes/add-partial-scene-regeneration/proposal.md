## Why

当前 Remotion 预览虽然按多段 scene 生成，但用户一旦对其中某一段效果不满意，只能重新发起整条预览生成，等待成本高且会重复消耗不需要重做的步骤。现在需要补齐“只修改当前片段”的局部返工能力，让用户能在暂停到某个 scene 时直接描述修改意图，并仅重生成这一段而不改动声音、时长和其它 scene。

## What Changes

- 为视频预览补充 scene 时间线元数据，让前端能够识别当前暂停帧对应的 scene，并将该 scene 作为可操作目标。
- 为 project conversation 消息入口增加结构化 scene revision 上下文，使“修改这一段”请求可以带着 `baseRunId`、`sceneId` 等明确信息进入后端，而不是依赖纯自然语言猜测。
- 新增局部 scene 重生成流程，复用既有 script、TTS、storyboard、scene timeline 和素材 grounding，只重写目标 scene 的 Remotion 代码并重新打包 preview bundle。
- 局部重生成不会调整配音、时间戳、scene 时长，也不会重新生成未命中的其它 scene。
- 局部重生成成功后产出新的预览版本；失败时保留原始预览可继续查看和导出。
- 为 scene 重生成补充运行中进度与错误反馈，避免用户误以为系统在重跑整条视频。

## Capabilities

### New Capabilities
- `preview-scene-targeting`: 让视频预览暴露 scene 时间线、识别当前暂停片段并发起绑定到该 scene 的修改请求。
- `partial-scene-regeneration`: 让系统基于已有成功预览只重生成目标 scene，并在不改变音频与时长的前提下生成新的预览版本。

### Modified Capabilities

- None.

## Impact

- 受影响前端：`src/app/(authenticated)/project/[projectId]/_components/previews/video/ProjectPreviewVideo.tsx`
- 受影响 API 类型：`src/app/api/types/project-conversation.ts`、`src/lib/project-conversation/types.ts`
- 受影响会话路由与快照构建：`src/lib/data/project-conversations-repository.ts`
- 受影响预览播放器与 bundle 生成：`src/lib/workspace/remotionPreviewPlayer.ts`、`src/lib/capabilities/remotion/generatePreview.ts`
- 受影响工作流：`trigger/workspace/goalToStoryboard.ts` 以及新增的 scene revision Trigger 入口
- 可能需要扩展 run 元数据以保存 scene revision 来源、scene timeline 或 design guide 等复用信息
- 不引入外部服务依赖，不改变最终导出的视频时长与音频内容
- 回滚方式：移除 scene targeting 与 scene revision 路由，恢复仅支持整条预览重生成的现状
