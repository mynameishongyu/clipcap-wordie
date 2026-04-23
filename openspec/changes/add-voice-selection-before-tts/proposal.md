## Why

当前产品在 script 确认阶段已经出现了“选音色 / 试听音色”的 UI 形态，但真实 TTS 生成仍然只读取单一的 `VOLCENGINE_TTS_SPEAKER` 环境变量，无法把用户选择真正传递到火山引擎。随着产品决定将音色选择前置到 TTS 之前，并以两种默认音色作为首发方案，需要把现有半成品交互收敛为一个可实现、可验证、可扩展的正式能力。

## What Changes

- 在 script 确认阶段正式引入“音色试听 + 音色选择”能力，并将其作为进入 TTS 之前的必经步骤。
- 首发版本提供两个策划精选的默认音色，每个音色包含稳定的展示名、描述、试听 sample 与对应的 Volcengine speaker 标识。
- 用户确认 script 时，系统必须同时提交并锁定本次 run 的音色选择，后续 TTS、storyboard 与 preview 生成都基于该音色执行。
- 后端必须校验音色选择是否合法，并将当前选择传递到 Volcengine TTS，而不再只依赖单一全局默认 speaker。
- 首发版本不支持“成片后无成本切换音色”；如需后续支持，应定义为一次新的旁白重生成能力，而不是当前 change 的一部分。

## Capabilities

### New Capabilities
- `project-conversation-voice-selection`: 定义项目在 script 确认阶段的音色展示、试听、选择、校验与 TTS 绑定行为。

### Modified Capabilities
- 无

## Impact

- 影响前端：
  - `src/app/(authenticated)/project/[projectId]/_components/previews/script/*`
  - `src/app/(authenticated)/project/[projectId]/_components/ProjectConversationProvider.tsx`
- 影响 API / 会话编排：
  - `src/app/api/projects/[projectId]/tasks/[taskId]/hitl/route.ts`
  - `src/lib/data/project-conversations-repository.ts`
- 影响 TTS 能力层：
  - `src/lib/capabilities/tts/generateTts.ts`
  - `src/lib/capabilities/tts/ttsCore.ts`
  - `src/lib/capabilities/tts/volcengineTts.ts`
- 影响配置与运行时契约：
  - 音色目录配置（speaker、展示名、试听 sample、默认顺序）
  - run / step metadata 中对 `selectedVoiceId` 或等价字段的持久化与恢复
- 风险与兼容性：
  - 试听 sample 与真实 script 合成结果可能存在轻微感知差异
  - 若音色目录与 Volcengine speaker 配置不一致，可能导致确认成功但 TTS 执行失败
