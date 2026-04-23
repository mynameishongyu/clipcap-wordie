## ADDED Requirements

### Requirement: URL-grounded production requests SHALL route to request generation
系统在识别 project conversation intent 时，MUST 将包含用户提供 URL 且同时表达视频、脚本、讲解、总结、制作或基于网页内容生成等制作意图的消息路由为 `start_from_request`。这类消息 MUST NOT 仅因为长度、URL 内部标点或多个句子片段而被路由为 `start_from_direct_script`。

#### Scenario: 用户提供网页并要求制作视频
- **WHEN** 用户发送包含 `https://` 或 `http://` URL 的消息
- **WHEN** 同一消息要求基于该网页、文章或来源内容制作视频、脚本、讲解或总结
- **THEN** 系统将该消息分类为 `start_from_request`
- **THEN** 系统创建 request-generation 路径的 turn/run，而不是 direct-script 路径的 run

#### Scenario: URL 内部点号不构成完整脚本证据
- **WHEN** 用户消息包含 URL，例如 `https://www.globaltimes.cn/page/202604/1358956.shtml`
- **WHEN** URL 内部的 `.`、路径片段或扩展名会被通用句子分割规则拆成多个片段
- **THEN** 系统在判断完整脚本时忽略 URL 内部标点产生的句子片段
- **THEN** 系统不得仅凭这些片段将消息分类为 `start_from_direct_script`

### Requirement: Direct-script routing SHALL require positive script evidence
系统只有在消息本身具备明确最终口播脚本特征时，SHALL 将其分类为 `start_from_direct_script`。完整脚本证据 MUST 来自自然语言脚本结构、多个脚本段落、明确旁白/镜头/字幕/scene 等脚本标记，或用户明确声明该文本是最终脚本；系统 MUST NOT 将普通制作说明、URL 说明或 brief 说明当作直接脚本。

#### Scenario: 真正完整脚本仍可跳过 draft generation
- **WHEN** 没有 run 处于 `WAITING_SCRIPT_CONFIRM`
- **WHEN** 用户发送多段完整口播脚本，且文本不依赖系统继续解析外部来源才能成为脚本
- **THEN** 系统可以分类为 `start_from_direct_script`
- **THEN** 系统使用该文本作为已提供 transcript 进入后续 TTS 流程

#### Scenario: 制作说明不会被当作最终脚本
- **WHEN** 用户发送的是制作要求、目标受众、时长、尺寸、来源 URL 或内容范围说明
- **WHEN** 消息没有明确最终口播脚本结构
- **THEN** 系统不得分类为 `start_from_direct_script`
- **THEN** 系统必须分类为 `start_from_request` 或 `clarify_intent`

### Requirement: Direct-script execution SHALL guard against source-grounded requests
即使 intent 结果为 `start_from_direct_script`，direct-script 初始化路径 MUST 在写入 confirmed script 状态前重新检查消息是否明显是 source-grounded production request。若命中该检查，系统 MUST 回退到 `start_from_request` 语义，而不是写入 `confirmedScriptToolId` 或启动 `script-confirmed-to-video` workflow。

#### Scenario: 防御性校验阻止错误确认脚本
- **WHEN** intent router 返回 `start_from_direct_script`
- **WHEN** 待初始化文本包含可规范化 URL 且表达基于该来源生成视频的意图
- **THEN** 系统不得写入项目级 `confirmedScriptToolId`
- **THEN** 系统不得把该文本作为 `scriptText` 触发 post-script workflow
- **THEN** 系统改用 request-generation 路径处理该消息
