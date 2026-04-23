## Context

当前项目的 Remotion 预览生成链路已经具备三个关键基础：

- `generateRemotionPreview()` 会按 storyboard scene 逐段生成 `SceneXX.tsx`，scene 粒度本身已经存在。
- `Root.tsx` 会导出 `sceneTimeline`，preview bundle 运行时也能解析这份时间线。
- `script-confirmed-to-video` 工作流已经可以复用既有 TTS、storyboard 与 render 输入，从 `render` 阶段继续执行。

但现状仍缺两层能力：

- 前端预览区只把 preview 当成一个 iframe，可播放但不暴露“当前暂停的是哪一段”。
- project conversation 的消息入口只有通用意图分类，没有确定性的局部 scene revision 路由。

这意味着系统底层已经知道 scene 的存在，却没有把它变成一个稳定的交互对象。用户只能重跑整条预览，无法对当前暂停片段发起局部返工。与此同时，这次需求又有明确边界：

- 不能改配音和视频总时长
- 不能重跑未命中的 scene
- 最好保留对话式交互，但不能让系统靠猜测决定“这一段”到底是哪一段

因此这不是单点 UI 改动，而是横跨 preview artifact、iframe 通信、conversation 路由、run 版本化和 Trigger workflow 的跨层设计。

## Goals / Non-Goals

**Goals:**

- 让视频预览暴露足够的 scene 时间线信息，使前端能识别当前暂停 scene。
- 让用户可以在当前暂停 scene 上输入修改说明，并把 `sceneId`、`baseRunId` 等结构化上下文一并提交。
- 基于已有成功预览只重生成目标 scene，复用原始 script、TTS、storyboard、scene timeline 和素材 grounding。
- 保持音频、时间戳、scene 时长与整体 timeline 不变。
- 局部重生成成功后提供新的预览版本；失败时不破坏源预览。
- 保持 project conversation 的主入口一致，让场景内操作仍然沉淀到会话历史。

**Non-Goals:**

- 不支持通过纯自然语言让系统自行猜测“这一段”是哪一个 scene。
- 不在本次变更中支持重写旁白、重算 TTS、调整 scene 时长或改总时长。
- 不在本次变更中重做 scene asset search 策略；默认复用原始素材 grounding。
- 不引入新的外部存储服务或新的实时传输协议。
- 不把旧预览 run 破坏性覆盖为新结果。

## Decisions

### 1. 继续复用 project conversation 消息入口，但为 scene revision 增加结构化 payload

预览区发起“修改这一段”时，仍然通过现有 `/api/projects/:projectId/messages` 类似的 conversation 入口提交用户文本，但请求体会增加可选的 `sceneRevision` 结构，至少包含：

- `baseRunId`
- `sceneId`
- `sourceToolId`
- `sourceFrame`
- `sourceTimeMs` 或等价定位信息

当该结构存在时，后端直接走 scene revision 初始化分支，而不是再交给意图分类器判断。

这样做的原因：

- 保留统一的会话历史与消息语义，不额外引入一个“只给 UI 用”的孤立 mutation。
- 避免纯自然语言意图分类错误绑定 scene。
- 让聊天内容和执行上下文同时存在，后续仍可在 timeline 中看到用户为什么改这一段。

Alternatives considered:

- 新建独立 `/scene-revisions` endpoint。
  Rejected，因为会把局部返工从 project conversation 剥离出去，历史追踪和权限收口都会分叉。
- 继续只靠意图分类器识别“修改这一段”。
  Rejected，因为缺少确定性的目标 scene 上下文，错误率不可接受。

### 2. 预览区通过 iframe 与父页面通信暴露当前 scene，而不是让父页面盲猜

当前视频预览只是一个 iframe。为了获得“当前暂停在哪个 scene”，需要让 preview bundle 内的 Remotion `Player` 主动把当前 frame、播放/暂停状态和解析出的 `sceneId` 通过 `postMessage` 发给父页面。

父页面只负责：

- 保存最新的 `activePreviewScene`
- 在暂停时展示 scene badge / 修改入口
- 提交带结构化 scene 上下文的消息请求

这样做的原因：

- sceneTimeline 与当前 frame 都在 iframe 内，那里最容易做准确映射。
- 父页面无需自己理解 Remotion 播放状态，也不需要解析 bundle 代码。
- 后续如果要支持手动 scene 列表或跳转，仍可复用同一份 scene timeline 通道。

Alternatives considered:

- 父页面单独拿 scene timeline 自己推算当前 scene。
  Rejected，因为现有 iframe 没有把当前 frame 暴露给外层，父页面缺少稳定状态源。
- 不做 iframe 通信，只在预览旁边列 scene 列表让用户手动选。
  Rejected，能做 fallback，但不能满足“当前播放暂停的那个片段”这一核心体验。

### 3. 局部重生成产出派生 run，而不是覆盖源 run

scene revision 会创建一个新的 pipeline run，并记录它来自哪个 `baseRunId` 与哪个 `sceneId`。新的 run 产出新的 `video` artifact，作为最新预览显示；源 run 仍然保留，失败时也能立即回退到原预览。

这样做的原因：

- 当前 timeline 与 artifact 都天然以 run 为粒度，派生 run 更符合现有模型。
- 覆盖源 run 会让导出状态、历史预览和错误恢复都变得脆弱。
- 派生 run 让后续多轮局部返工有清晰版本链，不需要在同一 run 上做破坏性变更。

Alternatives considered:

- 在原 run 上原地覆盖 preview bundle。
  Rejected，因为会破坏历史可追溯性，也会让失败恢复和并发导出更复杂。

### 4. 使用专门的 scene revision workflow，而不是把普通 render 重试逻辑硬扩成多模式

这次会新增专门的 Trigger 入口，例如 `workspace-revise-preview-scene`，其职责是：

- 校验 `baseRunId`、`sceneId` 和项目归属
- 恢复源 run 的 Remotion project、storyboard、TTS 音频与 scene timeline
- 复用原有 design guide 与目标 scene 的素材 grounding
- 只重写目标 `SceneXX.tsx`
- 重新打 preview bundle、上传 artifact、生成新的预览 run

普通 `script-confirmed-to-video` 仍然负责整条预览生成，不把“局部 scene 返工”塞进同一个执行分支里。

这样做的原因：

- 局部返工与整条生成的输入约束不同，拆开后失败定位和日志更清晰。
- 便于单独计费、单独做进度提示和单独限制功能边界。

Alternatives considered:

- 继续复用 `script-confirmed-to-video`，在 payload 里塞一个可选 `sceneRevision`。
  Rejected，因为会让原有工作流承载两种差异明显的执行模式，分支复杂度过高。

### 5. 默认锁定 timeline、音频与素材 grounding，并把 design guide 持久化为 render 元数据

如果只重生成一个 scene，却重新生成 run-level design guide，风格可能漂移；如果重新搜图，画面变化会超出“只局部返工”的预期。因此本次默认策略是：

- 复用原始 `sceneTimeline`
- 复用原始音频与 timestamps
- 复用原始 scene asset grounding
- 复用原始 run-level design guide

为此需要在首次成功 render 时把 design guide 作为可恢复元数据持久化，供后续 scene revision 直接读取。

Alternatives considered:

- 每次局部返工重新生成 design guide。
  Rejected，因为会让单个 scene 与其余 scene 的视觉系统不一致。
- 每次局部返工自动重搜图片。
  Rejected，因为用户当前需求聚焦“改这一段的生成效果”，不是发起新的素材搜索流程。

## Risks / Trade-offs

- [iframe 状态桥不稳定，导致当前 scene 识别抖动] → 只在 `pause` 态锁定 scene targeting；播放中仅更新显示，不允许直接提交。
- [派生 run 增加历史版本数量，timeline 变长] → 默认只把最新预览作为当前选中项展示，旧版本保留为历史可追溯数据。
- [局部重生成仍需重新打 bundle，用户误以为系统会秒返回] → 单独提供 scene regeneration progress 文案，明确说明是“只重生成当前片段并重新打包预览”。
- [未持久化 design guide 会导致局部返工风格漂移] → 在首次 render 成功时保存 design guide，并把它作为 scene revision 的必需恢复输入。
- [旧预览数据缺少 remotion project 或 scene timeline，无法局部返工] → 明确返回“不支持局部修改，只能整条重试”的能力判定，而不是进入半失败状态。

## Migration Plan

1. 扩展 preview artifact、conversation API schema 与前端 provider 类型，先让 scene timeline 与结构化 scene revision payload 能贯通。
2. 在 preview bundle 中加入 scene 状态上报，并在视频预览 UI 上提供暂停态 scene targeting 入口。
3. 为 run 成功 render 结果补充可恢复元数据，例如 design guide、base run 关系与 scene revision 来源。
4. 新增 scene revision workflow，并与 conversation 初始化逻辑打通，确保只重写目标 scene 文件并重新上传 preview artifact。
5. 联调成功后把局部 scene 重生成入口仅开放给支持 scene timeline 的 Remotion preview；其它预览继续维持只读或整条重试。

回滚策略：

- 移除 preview 端“修改这一段”入口与 scene revision payload 分支。
- 保留已有预览播放与整条重试逻辑，不影响普通脚本确认、预览生成和导出。
- 即使数据库里遗留派生 run 元数据，也不会影响旧版 UI 对已有 preview artifact 的读取。

## Open Questions

- 是否需要在第一版同时提供“手动选 scene”作为暂停态识别失败时的 fallback，还是先只支持“暂停当前片段”。
- 派生 run 是否要在 timeline 上显式展示“来源于哪个预览版本 / 哪个 scene”，还是先只在内部元数据保留。
- 局部重生成是否需要单独计费，还是先沿用 render 阶段的既有计费模型。
- 对历史旧 run，若缺少 design guide 元数据但有完整 Remotion project，是否允许降级执行，还是直接判定不支持局部返工。
