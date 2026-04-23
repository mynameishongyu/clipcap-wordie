## 1. Research Decision 与文本研究基础

- [x] 1.1 定义 research decision 的类型、模型输出 schema 与判定模块，覆盖 `shouldSearch`、`freshnessMode`、`reason`、`entityCandidates`、`searchQueries`
- [x] 1.2 在 `src/lib/workspace/` 下新增 Tavily 文本搜索封装与结果归一化逻辑，输出可复用的 research source documents
- [x] 1.3 为 Tavily 文本研究补充日志与调试字段，记录判定结果、query、命中来源数量与失败原因

## 2. 将研究结果接入 goal / script 工作流

- [x] 2.1 在 `start_from_request` 路径中插入 research decision，并在命中时执行 Tavily 文本研究
- [x] 2.2 合并用户显式 URL 抓取结果与 Tavily 研究结果，统一构建 `sourceContext` 并注入 `generateGoalVersion()` 与 `generateScript()`
- [x] 2.3 在 `freshnessMode = required` 且无可用研究来源时，中止 grounded script 生成并返回明确错误，而不是静默回退到旧知识

## 3. 持久化、重试与 workflow 一致性

- [x] 3.1 将 run 级 research source documents / `sourceContext` 作为脚本阶段的权威输入持久化下来
- [x] 3.2 修正 script retry 与历史回放逻辑，确保后续重试优先复用 run 首次研究得到的来源上下文
- [x] 3.3 在 Trigger workflow 与本地 fallback 路径中统一透传 research 相关 payload 与调试信息

## 4. Timeline / Preview 语义拆分

- [x] 4.1 为脚本前文本研究新增独立的 `research` tool timeline 类型与构建逻辑
- [x] 4.2 调整 project conversation UI 与 preview 面板，单独展示 research query、链接和摘要，并明确其已用于 goal/script
- [x] 4.3 保持现有 `search` tool 仅表示 storyboard/render 阶段的 scene image search，移除与文本研究混用的展示

## 5. 验证与回归

- [x] 5.1 验证显式最新事件请求会先做 Tavily 文本研究，再生成带来源上下文的 goal/script
- [x] 5.2 验证无显式时效词的现代公司介绍会触发研究，而 evergreen 常识主题不会被强制搜索
- [x] 5.3 验证 required research 无结果时的失败路径，以及 script retry / timeline 展示不会丢失首次研究来源

