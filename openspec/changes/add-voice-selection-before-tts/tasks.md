## 1. Voice Catalog 与契约定义

- [ ] 1.1 定义首发双音色 catalog 结构，明确 `id`、`name`、`description`、`audioUrl`、speaker 映射与主默认音色
- [ ] 1.2 为两个默认音色准备稳定的试听 sample，并确定前端展示顺序与文案
- [ ] 1.3 补充 voice catalog 的运行时校验与加载逻辑，确保无效 speaker 或缺失 sample 可被发现

## 2. 后端确认链路与 TTS 绑定

- [ ] 2.1 在 script 确认 API / repository 中校验 `selectedVoiceId`，并为缺失字段解析主默认音色
- [ ] 2.2 将本次音色选择持久化到 run / step metadata，保证后续 Trigger workflow、重试与快照可恢复
- [ ] 2.3 调整 TTS 能力层，使 Volcengine TTS 优先读取 run 绑定音色，而不是继续固定使用单一环境变量 speaker
- [ ] 2.4 为非法音色、已下线音色和旧路径兼容场景补齐错误处理与回退逻辑

## 3. 前端音色选择与试听体验

- [ ] 3.1 让 script 预览面板在 `WAITING_SCRIPT_CONFIRM` 阶段展示两个默认音色及其试听 sample
- [ ] 3.2 保持试听行为为纯前端音频播放，确保不会触发新的 TTS 或 workflow 请求
- [ ] 3.3 让确认按钮始终携带当前选中的音色提交，并在历史选中音色失效时回退到主默认音色
- [ ] 3.4 更新预览与会话状态映射，确保回放或刷新后仍能展示本次 run 绑定的真实音色

## 4. 验证与文档

- [ ] 4.1 验证两个默认音色都能完成完整链路：试听、确认、真实 TTS、storyboard、preview
- [ ] 4.2 验证未传 `selectedVoiceId` 的旧路径仍能使用主默认音色继续执行
- [ ] 4.3 验证非法 `selectedVoiceId` 会被拒绝，而不会静默切回其他音色
- [ ] 4.4 更新相关文档与环境配置说明，记录 catalog 维护方式、默认音色策略和回滚方案
