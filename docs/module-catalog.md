# 模块能力目录

本文维护模块的用户能力和协作边界。本体已提供本地冷加载的最小模块接入，
具体支持范围见[模块协议](module-contract-draft.md)；表中的显示名称不决定 moduleId。

## 能力

| 模块能力 | 用户能力 | 与本体的协作 |
| --- | --- | --- |
| 文件 | 首版聊天上传、托管、下载、输入区附件和媒体卡片；全局文件库延后。 | [cockpit-file](https://github.com/waksana/cockpit-file) 使用原生附件与新实时通知；不补抓历史，发送仍由本体完成。 |
| 通知/收件箱 | 未读/已读、提醒、去重、订阅、push 和 badge。 | [cockpit-notification](https://github.com/waksana/cockpit-notification) 独立实现内存未读与推送；本体只提供消息边缘/会话标记等通用插口，普通消息、原生决策和 API 错误提示仍由本体提供。 |
| 语音 | 听写、语言、采音、识别提供方及令牌。 | 编辑原草稿；发送录音时使用文件能力，由本体执行一次正常发送。 |
| 会话整理 | 置顶和首回复自动命名策略。 | 使用原生命名 API，保存额外整理偏好；标题和历史仍以原生为准。 |
| 系统状态展示 | 系统、模块版本和外部运行状态看板。 | 读取各自权威接口；普通版本与健康信息由本体提供。 |
| 下次启动消息 | 保存下一次启动的 prompt，展示发送尝试、受理、失败或 unknown。 | 记录落盘后可调用本体退出；下一次宿主就绪后使用普通 prompt API。 |
| Context Reset | self-only 上下文清理工具、skill 与交接。 | 使用明确的原生生命周期操作，保持它与 compaction、rewind 和服务退出的区别。 |
| Assistant | 公开角色、skills 和模板。 | 显式应用到原生 session，遵循工作区规则；用户人格与记忆由用户持有。 |
| Task | 目标、授权、身份、Commander/Owner、业务投递和结果。 | 自有业务状态，通过公开 API 使用原生 session。 |
| 微信 | 渠道绑定、收发、媒体和 unknown 处理。 | 自有渠道数据与恢复策略，通过公开 API 使用原生 session。 |

Task 与微信源码仍分别属于
[cockpit-task](https://github.com/waksana/cockpit-task)、
[cockpit-wechat-connector](https://github.com/waksana/cockpit-wechat-connector)。
两者需要按共同协议完成模块接入；仓库存在不等于宿主已经支持安装。
原生 `assistant` 消息和 `task` 子代理属于 SDK，与这两类业务角色分别命名。

## 共同约束

模块使用公开产品 API 和有版本的前端协作接口，拥有自己的配置、秘密引用和业务数据。
原生会话、历史、队列、模型上下文、MCP/skill 开关仍由 Copilot 管理。
模块启动失败时局部禁用并报告错误；首版为受信任主进程 import，不提供进程级沙箱。

graceful 退出只关注原生 session 空闲。模块活动不阻止宿主退出，未完成业务可能被打断；
模块自己处理恢复和 unknown，不自动重发结果不明的操作。
下次启动消息的记录应先落盘，再请求宿主退出。
