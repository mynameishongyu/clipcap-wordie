## 1. Intent Routing

- [x] 1.1 在 `projectConversationIntent` 中增加 URL/source-grounded request helper，复用现有 URL 规范化语义识别 `http(s)://` 来源。
- [x] 1.2 调整 intent 判定顺序，让含 URL 且带制作意图的消息优先返回 `start_from_request`，早于 `start_from_direct_script`。
- [x] 1.3 修改 `looksLikeFullScript()` 的句子统计逻辑，在计数前忽略 URL 内部标点，避免 URL 被拆成多个脚本句子。
- [x] 1.4 收紧 direct script positive signal，确保普通制作说明、brief、URL 来源说明不会仅凭长度被当作完整脚本。

## 2. Request 与 Direct Script 防御

- [x] 2.1 在 `initializeDirectScriptMessage()` 或其调用前增加 source-grounded request guard，命中时回退到 `initializeStartFromRequestConversationMessage()`。
- [x] 2.2 验证 direct script guard 命中时不会写入 `confirmedScriptToolId`、不会把原始 URL 请求写入 `scriptText`、不会触发 post-script workflow。
- [x] 2.3 为 `start_from_request` 增加条件化 `goalConfirmationMode` 选择，URL/source-grounded 请求使用 `required`，普通快速请求保持现有策略。
- [x] 2.4 调整后台 bootstrap 完成后的 turn/run 更新，使 source-grounded request 的 generated brief 保持 pending，并继续通过既有 script confirmation gate 阻止 TTS/render 后续生产。

## 3. Source Research 与 Timeline

- [x] 3.1 确认用户提供 URL 的请求在 goal/script 生成前执行 URL extraction，并保存 turn/run 级 `sourceDocumentsJson` 与 `sourceContext`。
- [x] 3.2 确认 URL extraction 全失败时阻止基于来源的脚本生成，并返回可操作错误信息。
- [x] 3.3 确认 URL source documents 在 conversation timeline 中显示为 research 来源，而不是 scene asset search。

## 4. Tests

- [x] 4.1 增加 intent routing 测试：Global Times URL 制作请求应分类为 `start_from_request`。
- [x] 4.2 增加 full script 判定测试：URL 内部点号不增加脚本 sentence count，长 URL 制作说明不触发 direct script。
- [x] 4.3 增加 direct script 正向测试：真实多段最终口播脚本仍可分类为 `start_from_direct_script`。
- [x] 4.4 增加 repository 层测试或等价集成测试：URL request 不写入 `confirmedScriptToolId`，且使用 request-generation 路径。
- [x] 4.5 增加 source-grounded confirmation 测试：带 URL/source 的 request 生成 pending brief，并在确认前不触发 post-script workflow。

## 5. Validation

- [x] 5.1 运行目标测试、`pnpm typecheck`，并按 touched files 运行 ESLint。
- [x] 5.2 使用原始输入 `https://www.globaltimes.cn/page/202604/1358956.shtml ...` 通过 `pnpm url-intent:validate` 复现路由，确认不会把原始请求作为 direct-script `scriptText`。
- [x] 5.3 检查失败与回滚路径：Firecrawl 不可读时给出明确错误；关闭确认分支时仍能保留 URL-aware routing 修复。
