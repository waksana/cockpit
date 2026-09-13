# 合成契约示例，不是安装包

这些文件只表达 URL模块契约草案中的数据形状与流程：

- [clipbook.module.json](clipbook.module.json)：此前未预置的moduleId，角色/MCP、服务、actions/events、页面。
- [assistant.module.json](assistant.module.json)：无服务、配置或业务data也可完整使用的内容模块。
- [task-adapted.module.json](task-adapted.module.json)：现有Task向通用接入契约的代表性映射；只示例一个work action，
  **不是完整Task新发行，不代表已发布或部署版本**。
- [clipbook.release-payload.json](clipbook.release-payload.json)：应置于外部签名外壳内的发行payload。
- [requests-and-receipts.json](requests-and-receipts.json)：inspect/verify/use-plan、同Web/MCP调用、控制消息与错误。
- [atomic-lifecycle.json](atomic-lifecycle.json)：单独install/configure/start/apply/drain/uninstall及Assistant完成状态。
- [context-and-wire.json](context-and-wire.json)：私有context、hello、动态owner接入和固定provider的page lease。
- [files-via-http.json](files-via-http.json)：模块直接上传文件，再发送附件引用；不经过JSONL文件转发。
- [clipbook.home.page.json](clipbook.home.page.json) / [task.dashboard.page.json](task.dashboard.page.json)：首版无脚本schema-page例子，
  发布者分别放到对应manifest声明的 `web/` entry位置；不是HTML/JS页面。

受信任并启用的模块默认访问所有公开host API，不声明hostAccess/hostGrant或逐API
权限列表。模块业务鉴权、API本身的认证/确认/busy/unknown规则保留；selectableBy
仅表达普通UI建议入口，不给角色授予业务身份。这些新协议例子不兼容旧模块接口或路径。

所有 `.invalid` URL、重复字符digest、公钥指纹、字节数和 `native_demo_*` ID
都是**占位的合成例子**，不对应网络文件、有效签名、真正native session或已执行结果。
这里没有生成/下载归档，没有执行示例entry，没有申请信任或安装模块。
JSON解析、引用/形状检查只能证明草案内部表达，不证明包完整性、发布者信任或生产功能。

真正发布时必须以实际文件字节计算manifest/归档摘要与大小，再按外部签名格式签名。
不可把本例中的摘要、公钥指纹或期望回执粘贴进生产来宣称验证成功。

完整候选定义与状态规则见[模块契约草案](../../module-contract-draft.md)。
