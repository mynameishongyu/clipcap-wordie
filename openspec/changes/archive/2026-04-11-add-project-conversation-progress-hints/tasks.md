## 1. Progress Hint Contract

- [x] 1.1 在 `src/app/api/types/project-conversation.ts` 定义独立的 progress hint 类型与 schema，并把它接入 `ProjectConversationSnapshot` 和 `ProjectConversationMutationResult`
- [x] 1.2 在 conversation repository 的任务/快照构建路径中补齐 progress hint 的读写入口，确保其与 `activeTask` 分离但使用同一 `taskId` 绑定
- [x] 1.3 明确 progress hint 的最小字段集合，满足本次单气泡替换展示，并保留后续会话内进度流可复用的稳定阶段标识

## 2. Repository Progress Mapping

- [x] 2.1 在 `src/lib/data/project-conversations-repository.ts` 实现从 `currentStep`、step `message`、运行耗时到 progress hint 的归一化映射
- [x] 2.2 为 `script`、`tts`、`storyboard`、`render`、`export` 建立用户可读文案和 ETA 规则，其中 `asset search` 继续作为 `render` 的子阶段提示
- [x] 2.3 在 start-from-request、direct-script continuation、retry continuation 等运行中入口上返回首个 progress hint，并在轮询 snapshot 中持续暴露最新 progress hint

## 3. Frontend Pending Bubble Integration

- [x] 3.1 在 `src/app/(authenticated)/project/[projectId]/_components/ProjectConversationProvider.tsx` 用 progress hint 替换固定的 `Preparing creative brief...` pending assistant 文案
- [x] 3.2 让同一 `taskId` 的 pending assistant 在轮询到阶段变化时更新文案，而不是追加新的 assistant timeline 项
- [x] 3.3 在任务结束、等待确认、失败、取消或真实 timeline 足够替代 pending 态时清理本地 pending progress 展示

## 4. Validation

- [x] 4.1 验证新请求启动后会先显示脚本阶段提示，再随工作流推进更新为 TTS、storyboard、render 等阶段
- [x] 4.2 验证 render 阶段使用“搜索参考图片并生成预览”一类组合提示，且不会因为本次需求引入新的 pipeline step
- [x] 4.3 验证长耗时阶段的 ETA 文案符合预期，至少覆盖最终导出“预计 3-5 分钟”，并在 progress hint 缺失时安全回退
