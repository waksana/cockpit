# 历史资料

本目录保存**非当前规范**：早期 PoC、设计研究、审阅和返工记录。
它们能解释当时如何决策，不能指挥当前实现、恢复已退役能力或提供新的操作授权。
当前文档只有[主索引](../README.md)指定的正文。

| 资料 | 时间/性质 |
| --- | --- |
| [SDK PoC](POC-FINDINGS.md) | 2026-06-16 的旧进程内 API 调查；已被进程外 SDK 替代。 |
| [Telegram 研究](telegram-study.md) | 历史设计参考，包含后来被否决的建议；不是当前行为清单。 |
| [tweb 差异记录](cockpit-tweb-diff.md) | 历史样式/交互来源；当前署名只维护在 [NOTICE](../../NOTICE.md)。 |
| [Chat 组件设计](chat-design-review.md) | 2026-09-12 组件记录，包含已停放的文件/语音场景。 |
| [Composer 返工](chat-composer-rework.md) | 旧版本比较和设备证据边界，不是当前增强可用性。 |
| [早期全仓审阅](review/00-index.md) | 历史审阅及其 deep/fixes；不是当前源码已重新审过的证明。 |
| [2026-06-22 补充审阅](review/20260622-0756/00-index.md) | 当时限定变更的证据。 |
| [2026-09-08 底座审阅](review/2026-09-08-foundation.md) | 当时的 SDK/功能范围，不覆盖后来的薄本体提取。 |

每页有历史标识和迁移前的固定 Git 链接。归档只修复导航，不重新执行当时脚本、
重写结论或把旧行号解释为当前行号；文内旧路径/环境按原记录理解。
找不到旧代码时从固定 Git 来源追溯，不为保住旧链接恢复产品逻辑。

源码提取留下的字节级原件另在 [`module-staging`](../../module-staging/README.md)，
由 source inventory 管理，不是可自由改写的当前文档副本。
较早的性能数据可在
[提取版本的验证文档](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/cockpit-testing.md#historical-performance-baseline)
追溯；部署历史统一由[部署记录](../deployments.md)导航。
