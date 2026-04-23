## 1. Baseline 与观测

- [x] 1.1 在 `scene asset enrichment` 链路补齐 `per-scene` 级结构化耗时字段，覆盖 `search / judge / download / write`、`contentType`、`fileSizeBytes`、来源 host 与最终状态
- [x] 1.2 为新增耗时字段补齐配置开关或摘要化策略，避免高频 run 产生失控日志体积
- [x] 1.3 建立优化前基线，对比记录当前 blocking enrichment 模式下的总耗时、各子步骤耗时与 fallback/失败分布

## 2. A 类优化：bounded judge

- [x] 2.1 在 `sceneAssetRelevance` 中实现 heuristic gating，支持在 top candidate 明显领先或候选不歧义时跳过 LLM judge
- [x] 2.2 为 judge 调用增加更快模型选择、timeout 与并发上限，并在超预算时回退到 heuristic top candidate 或非图片 visual
- [x] 2.3 补充 judge 相关测试与回归用例，验证“跳过 judge”“judge 超时”“judge 歧义命中”三类路径

## 3. B 类优化：lightweight materialize

- [x] 3.1 在 `sceneAssetMaterialize` 中增加下载前 guardrails，校验 `content-type`、`content-length`、下载时长与允许的来源类型
- [x] 3.2 为 GIF、超大 PNG/JPEG、未知类型资源实现拒绝、降级或轻量化落地策略，确保输出是 Remotion 可直接 import 的本地 preview asset
- [x] 3.3 补充 materialize 相关测试与样例验证，覆盖大 GIF、超大图片、超时下载与正常轻量资源路径

## 4. C 类优化：selective image routing

- [x] 4.1 收紧 `sceneAssetIntent` 的 `image` 路由规则，优先将抽象说明、过渡、CTA、低信息密度 scene 路由到 `motion-only`、template 或 fallback visual
- [x] 4.2 为 hero/demo/product/person/place 等高视觉依赖 scene 保留进入图片搜索链路的明确命中条件或白名单策略
- [x] 4.3 补充 storyboard / scene intent 回归用例，验证减少 image scenes 后 preview 质量仍可接受

## 5. 集成验证与 rollout

- [x] 5.1 将 A/B/C 三类优化接入 blocking preview 主链路，确保 `generateRemotionPreview()` 继续只消费本地 materialized assets
- [x] 5.2 基于同类 storyboard 比较优化前后的总 preview 耗时与 `search / judge / download / write` 子步骤耗时，确认关键路径得到实质缩短
- [x] 5.3 验证导出阶段不再因 remote source 加载失败回退到 `Visual unavailable`，并确认 scene-level fallback 仅影响超预算或违规素材的 scene
- [x] 5.4 更新相关设计/运维文档与 feature flag 说明，明确 rollout 顺序、阈值调优方法与逐项回滚步骤
