# 模块目录

本页区分**可安装模块、待适配的独立项目和后续方向**。模块单独发行，不随本体安装。
下面的配套说明核对于 **2026-09-18**，面向
[Cockpit v0.2.4](https://github.com/waksana/cockpit/releases/tag/v0.2.4)。
**0.2.4 配套 / 发布资产以对应 Release 为准**；文档准备完成不表示发布已完成。
包格式、安装命令和前后端接口统一见[模块接入协议](module-contract-draft.md)。

## 可安装模块

| 模块 | 用途 | 配套发行与使用说明 |
| --- | --- | --- |
| [Cockpit File](https://github.com/waksana/cockpit-file) | 在聊天中选择、拖入或粘贴附件；预览、下载文件和媒体。 | [v0.1.7 运行包](https://github.com/waksana/cockpit-file/releases/tag/v0.1.7) · [安装说明](https://github.com/waksana/cockpit-file/blob/v0.1.7/docs/installation.md) |
| [Cockpit Notification](https://github.com/waksana/cockpit-notification) | 为新回复和待回答问题提供未读标记、会话计数、Web Push 与应用角标。 | 0.2.4 配套 [v0.1.5 Release](https://github.com/waksana/cockpit-notification/releases/tag/v0.1.5) · [使用说明](https://github.com/waksana/cockpit-notification/blob/v0.1.5/README.md)；发布资产以该 Release 为准。 |

File 0.1.7 已发布且继续兼容，本轮不重新发行；Notification 0.1.5 配套本次菜单及 payload 能力。
两者使用包/后端 API v1、Web API v2、公共 UI v1，通知模块另外检查独立菜单能力 `menuVersion: 1`。
确认对应 Release 的 `.tgz` 与校验文件均已发布后，再下载、校验并按模块说明配置，
用本体的[本地安装命令](module-contract-draft.md#2-包格式与本地安装)
显式信任并启用；下次冷启动才会加载。查询时区分“下次选中”与“当前已加载”，安装命令不会重启服务。

### 文件

文件模块增强真实输入区，负责选择器、粘贴/拖放、上传状态、草稿附件和媒体展示；
本体仍负责发送消息。启用后的新上传和新实时回复可以保存文件，
同一路径后续变化不会覆盖旧消息已捕获的版本。

它不扫描或补存旧聊天，不是服务器项目文件编辑器。
全局文件库、搜索和从文件库选择附件仍属[后续计划](https://github.com/waksana/cockpit-file/blob/v0.1.7/docs/roadmap.md)。

### 通知

通知模块记录主 Agent 最终回复和当前待回答问题的未读状态，显示消息红线与会话状态末尾计数。
设备通知开关只放在现有全局菜单中，控制本设备；没有独立铃铛、页面级未读总数、
通知对话框或页头控件。打开会话不等于清空未读，已读判定基于真实消息正文及当前 ask
问题的 `bodyRef` 在前台的实际呈现。
推送订阅、浏览器 worker 和角标由模块管理，不由本体申请权限。

Web Push 和角标取决于浏览器、设备及用户授权，不保证必达或跨设备瞬时一致；
持久化、恢复及其他业务限制以
[0.1.5 说明](https://github.com/waksana/cockpit-notification/blob/v0.1.5/docs/release-notes.md)为准。

0.1.5 需要模块 SSE payload 接口与独立菜单注册，不能与已发布 Cockpit 0.2.3 混用。
其 `tooling/host-sdk.json` 保留兼容 API 的精确源码 pin，而不是按开发包标签推断能力；
完整 SHA 与导出版本解释见[模块协议](module-contract-draft.md)。
历史 **Cockpit 0.2.3 → Notification 0.1.0** 配套仍以对应 tag/Release 为准，
不因本轮文档或源码更新而改变旧资产。

## 独立项目：待适配当前模块体系

| 项目 | 已有用途 | 已发布版本 |
| --- | --- | --- |
| [Cockpit Task](https://github.com/waksana/cockpit-task) | 结构化任务、明确授权的派单、Commander/Owner 协作与执行者报告；不是自动调度或自动监工。 | [v1.2.7](https://github.com/waksana/cockpit-task/releases/tag/v1.2.7) |
| [Cockpit WeChat Connector](https://github.com/waksana/cockpit-wechat-connector) | 把一个授权微信私信用户连接到指定会话，收发文本及支持的媒体；群聊和原生语音未接入。 | [v0.1.6](https://github.com/waksana/cockpit-wechat-connector/releases/tag/v0.1.6) |

两者已有实现和独立 ZIP 发布包，但使用 `module.json` 与独立服务协议，
不是当前宿主的 `cockpit.module.json` / `.tgz` 格式，**不能直接用当前模块 CLI 安装**。
其角色应用和会话绑定等接入仍需适配；也不能仅凭项目中的“Cockpit API 1”
就认定与当前宿主完全兼容。各自业务文档由对应仓库维护。
原生 `assistant` 消息和 `task` 子代理属于 SDK，不等同于这些业务角色。

## 后续方向

下表不是已发布模块清单，也不是对当前安装包的功能承诺。

| 方向 | 预期用途与协作边界 |
| --- | --- |
| 语音 | 听写、采音、语言与识别提供方；编辑原草稿，发送录音时使用文件能力和正常发送流程。 |
| 会话整理 | 置顶、首回复自动命名等策略；使用原生命名 API，额外偏好由模块保存。 |
| 系统状态展示 | 系统、模块版本和外部运行状态看板；普通版本与健康信息仍由本体提供。 |
| 下次启动消息 | 先保存下一次启动的 prompt，再请求退出；下次就绪后记录普通发送的受理、失败或 unknown。 |
| Context Reset | self-only 上下文清理工具、skill 与交接；与 compaction、rewind 和服务退出分别处理。 |
| Assistant | 公开角色、skills 和模板，显式应用到原生 session；人格与记忆由用户持有。 |

## 共同约束

模块使用公开产品 API 和有版本的前端协作接口，拥有自己的配置、秘密引用和业务数据。
原生会话、历史、队列、模型上下文、MCP/skill 开关仍由 Copilot 管理。
模块启动失败时局部禁用并报告错误；首版为受信任主进程 import，不提供进程级沙箱。

graceful 退出只关注原生 session 空闲。模块活动不阻止宿主退出，未完成业务可能被打断；
模块自己处理恢复和 unknown，不自动重发结果不明的操作。
下次启动消息的记录应先落盘，再请求宿主退出。
