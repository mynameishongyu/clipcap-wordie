## 1. Contracts And Routing

- [ ] 1.1 扩展 `video` preview artifact 与相关 API schema，返回 scene timeline 元数据和 scene-targeting 能力标记
- [ ] 1.2 为 project conversation 消息输入增加结构化 `sceneRevision` payload，并在 repository 中新增确定性的 scene revision 初始化分支
- [ ] 1.3 为 pipeline run / render 成功结果补充可恢复元数据，至少覆盖 `baseRunId`、目标 `sceneId`、design guide 与相关 revision 来源信息

## 2. Preview Interaction

- [ ] 2.1 修改 preview bundle/player，让 iframe 向父页面上报当前 frame、播放/暂停状态和解析出的 `sceneId`
- [ ] 2.2 在 `ProjectPreviewVideo` 中实现暂停态 scene targeting UI，并采集用户对当前片段的修改说明
- [ ] 2.3 在前端 provider 中接入 scene revision 提交、进行中的 progress 展示以及失败后的回退体验

## 3. Scene Revision Workflow

- [ ] 3.1 新增专用的 Trigger scene revision 入口，校验 `baseRunId`、`sceneId` 与项目归属
- [ ] 3.2 恢复源 run 的 Remotion project、storyboard、TTS 与素材 grounding，只重写目标 `SceneXX.tsx`
- [ ] 3.3 复用原始 timeline 与音频重新构建 preview bundle，产出新的派生 run，并在失败时保持源预览可用

## 4. Verification

- [ ] 4.1 为 preview scene timeline、paused scene targeting 与 structured scene revision routing 添加测试
- [ ] 4.2 为单 scene 重生成、时长不变、未命中 scene 不重跑和失败不破坏源预览添加 workflow / repository 级测试
- [ ] 4.3 执行手工验证：暂停当前片段 -> 输入修改说明 -> 新预览生成 -> 跳回修订片段复看 -> 导出仍然可用
