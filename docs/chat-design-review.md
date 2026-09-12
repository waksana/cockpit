# Chat 组件设计精修 · 2026-09-12

这是源码与隔离浏览器验收记录，**不是生产上线记录**。保留 Solarized、
右侧用户气泡、文档式助手回复与无装饰动画的产品语言，不重做导航或模块业务。

## 可操作场景

在独立工作树安装锁定依赖后运行：

```sh
COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev \
  --host 127.0.0.1 --port 47831 --strictPort
```

Chrome 打开 `http://127.0.0.1:47831/chat-lab.html?scene=all`。
选择器提供 21 个场景；`reading`、`process`、`attachments`、`streaming`、
`ask`、`plan`、`history` 可直接通过 `scene` 参数进入。上方控制面板可以
保持请求中、释放结果、模拟失败、切换连接、暂存文件、追加流式片段、结束回合、
插入历史和驱动合成语音回调。控制面板不是产品 UI。

场景直接挂载生产 `Thread`、`Composer`、`MessageBody`、`MessageContent`、
`ChatFileCard`、`FileCard`、`ChatHeader`、`ModeMenu` 和 `AnchoredMenu`。
不是另写的消息样机。`ChatHeader` 从 App 的原 JSX 提取，生产与场景共用。
问答、发送、上传和分页回调只操作合成输入并显示回执；**不调用 App/init、
不注册原生 session、不创建后端、不复制真实历史、不发送测试消息**。
草稿仅使用隔离 localhost origin 的现有 Composer 实现。

开发入口必须显式启用。它不进入通常的 Vite 生产构建；lab 插件只在 serve 模式生效。
lab 强制同源媒体，并用 CSP 阻止外源请求；未知 intent、stream 和 uploads 返回失败，
没有生产代理或兜底。正常 Web 的 BASE_URL 与原生协议不变。
视频是自行生成的两秒 WebM；图片是本任务原创 SVG。文件详情复用生产 FileCard，
可播放、暂停、seek、下载和查看来源，样例不是托管库权威数据。

初轮发现默认开发媒体配置会指向外部开发域，图片请求在 DNS 阶段失败；这不算媒体验收。
修正隔离入口后重新录制，最终录制清单没有外源请求或未捕获脚本错误。

## 设计依据与参考边界

| 编号 | 来源 | 实际取得与借鉴 |
| --- | --- | --- |
| P | [Primer Button](https://primer.style/product/components/button/) 与 [accessibility](https://primer.style/product/components/button/accessibility/) | Chrome 打开官方可运行示例，操作代码展开/收起；阅读焦点、按钮命名、loading 与 target-size 指引。借鉴明确标签、稳定焦点和克制的主次按钮，不照搬 GitHub 品牌。 |
| C | [Carbon Code snippet](https://carbondesignsystem.com/components/code-snippet/usage/) 与 [多行实时示例](https://react.carbondesignsystem.com/iframe.html?id=components-codesnippet--multiline&globals=theme:white) | Chrome 操作 Show more/less 和复制，观察 Copied to clipboard 与焦点保留。用于代码栏、复制反馈、横向长行；不引入编辑器或代码执行能力。 |
| F | [Carbon File uploader](https://carbondesignsystem.com/components/file-uploader/usage/) | 文档参考，非上传实测。用于暂存行对齐、文件名省略与完整名称、独立移除、上传/失败/完成分离；附件按钮不与发送按钮争夺主操作。 |
| G | [GitHub Copilot Chat 官方 IDE 使用说明](https://docs.github.com/en/copilot/how-tos/chat-with-copilot/chat-in-ide) | 官方文档参考，非登录 IDE 实测。借鉴任务过程、工具与最终回复的分层，以及计划需明确选择的交互；不照搬其子代理生命周期或模式规则。 |
| W | [WAI disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) 与 [WCAG 对比度依据](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | 规范参考。用于完整行 disclosure、展开状态、键盘操作与文本对比度；不将一次浏览器检查称为完整 WCAG 认证。 |
| R | [项目产品要求 R1–R8](product-requirements.md) 与 [原生聊天](native-chat.md) | 自身约束：原生唯一权威、自然文档布局、单一阅读控制、稳定媒体框、按需历史、无静默重试。正确项有意识保留。 |

未把无法取得的 ChatGPT/Claude 页面、历史研究或视频当作亲自操作的证据。
统一原则是“**正文清楚，过程可查，决策明确，结果诚实**”，不是拼贴品牌或添加渐变装饰。

## 逐组件覆盖与结论

下面是从实际源码分支盘点的清单，而非选取几个漂亮例子。场景名称对应选择器；
动作回执表示生产组件调用了正确的 fixture 回调，不表示调用过真实 SDK。

| 组件 / 实际状态 | 基线判断 | 依据 | 改动或保留结论 | 场景与操作 |
| --- | --- | --- | --- | --- |
| 用户消息、长段落、连续标识符 | 右侧气泡正确，但宽屏跨度过大、时间太淡 | R/W | 保留气泡与时间归属；统一阅读列，调整气泡密度和小字对比 | reading，桌面/390/320px，复制与换行 |
| 助手文档、连续消息、byline | 文档式回复正确；正文层级弱 | R/G | 保留非气泡与分组 byline；更清楚的文档节奏，不给每段加卡片 | reading/process |
| ask-reply 回复标记 | 已正确区别问答回复 | R | 保留“回复”标签与原始内容语义，统一辅助字号 | reading/ask，选择后查看追加回复 |
| 日期、跨日与消息锚点 | 日期与 prepend 的身份保护正确 | R | 保留日期判断和稳定 data-message-id；降低日期装饰权重 | history，跨日插入前后对照 |
| system info / warning / error | 严重性已有区分，但长通知像拉长胶囊 | P/W | 保留真实级别；有界圆角、换行、可读错误色 | process，三种系统记录 |
| skill 激活记录 | 简洁、识别明确 | R | 保留独立轻量记录；长名称可换行，小字不再靠透明度变淡 | process |
| H1–H6 | H1–H4 同字号，H5/H6 默认样式脱节 | C/W | 24/20/17.6/16/14.4px 梯度；一致字重、行高与上下间隔 | reading，六级标题同场 |
| 段落、软换行、中英混排 | 容器 pre-wrap 把 Markdown 块间源码换行也排成空白行 | C/R | 容器 normal，段落保留软换行；正文行高 1.7 | reading |
| 强调、斜体、删除线、链接 | 语义已正确，不需要重造 | W/R | 保留 GFM 和安全新页链接；统一可读链接色与下划线间距 | reading，点击公开链接 |
| 有序/无序/嵌套列表 | 基本正确，但行距紧，层级节奏不一致 | C/W | 保留语义和缩进；调整列表与子列表节奏 | reading |
| GFM task list | 只读勾选与可操作任务不能混淆 | R | 保留 disabled checkbox；调整对齐，不增加修改任务能力 | reading |
| 引用、分隔线 | 引用依靠整体 opacity，文字偏淡 | W | 保留左侧引用线；取消整体淡化，统一分隔节奏 | reading |
| 表格、对齐与窄屏宽表 | 有横向 overflow，缺少可发现的键盘区域 | C/W | 保留 GFM 对齐；增加有名称的 focus 区与左右键横滚 | reading，六列表格，ArrowRight 实操 |
| 行内代码 | 已正确内嵌，不应处处出现按钮 | C | 保留纯文本内嵌样式，只调整字阶 | reading |
| 多行代码、diff、终端长行 | 缺少局部复制，读者只能手工选中 | C/P | 稳定 renderer 增加语言栏、复制和反馈；不加高亮库、运行或编辑能力 | reading，复制后 Ctrl+V 与原文本逐字一致 |
| 代码 / 参数 / 输出复制失败 | 原右键复制吞掉错误 | P/C | 明确 pending、已复制、失败反馈；保留焦点，失败可手工选文 | reading/process，拒绝剪贴板的受控分支 |
| 思考 live / ended / 手动覆盖 | live 展开、结束收起的规则正确；内容对比不足 | W/R | 保留生命周期与手动选择；扩大点击区，改善阅读线与文字 | process/streaming，展开、收起、结束回合 |
| 工具 completed / failed / in_progress / pending / 缺失状态 | 颜色承担状态；缺失被视觉归为 pending | G/W/R | 每行有状态文字；缺失明确“状态未知”，不猜测完成 | process，五种真实 schema 分支 |
| 工具标题与极长原生名称 | 390px 下名称挤成 654px，标题宽度变成 0 | P/W | 整行按钮；窄屏名称独立次行并省略，展开可读全名 | process，before/after、320px |
| 工具参数、输出、空详情 | 原可展开，但箭头小，参数输出缺少标签 | C/W | 标注参数/输出与各自复制；详情可键盘滚动；没有详情仍不造按钮 | process，主/子工具均打开 |
| 子代理 running / activity | 已有“记录”语义正确，不能视为当前运行状态 | R/G | 原字义、路由、生命周期均保留；克制边界替代一片强调色 | process，分别展开/关闭 |
| 子代理 completed / failed / cancelled / unknown | 终态不等于整个任务完成；emoji 在当前 Chrome 中缺字 | R/W | 保留每个状态与解释；改用现有图标字体，统一标题/状态排列 | process，六种状态全部操作 |
| 子代理 prompt / thought / tools / subMessages | 共享窗口与自然展开正确 | R | 保留生产递归组件、持有阅读头和 message key；不另读子历史 | process，嵌套思考/工具/正文 |
| 子代理无消息 / error / 待同步 | 真实缺口不能被成功样式掩盖 | R/P | 保留窗口内暂无记录、错误和断线提示；仅修排版 | process，unknown 空子树，切换连接 |
| 用户/助手多个附件 | 同一文件卡复用、去重正确 | F/R | 保留网格、顺序和首次预览去重；不新建媒体缓存 | attachments |
| `attachment` / `attachments` / ordered `parts` | 兼容入口与文字文件顺序正确 | R | 保留生产 MessageContent；复制按有序 parts 输出 | attachments，首尾说明、重复文件、单附件 |
| 图片 ready / loading / failed | 固定框是近期正确成果 | R/F | 保留初始媒体槽与稳定 img 节点；只调整框内信息行 | attachments，延迟加载前后高度相等 |
| 视频卡与详情播放器 | 稳定卡片进入播放器比消息内自动播放可靠 | R/F | 保留新页详情入口与原生 video controls | attachments，真实播放/暂停/seek 到 0.8s |
| 普通文件、未知格式、无效 URL | 需要区别格式未知与地址错误 | R/F | 保留明确错误；名称、格式、体积层级统一；不会因复制无效 URL 崩溃 | attachments |
| metadata pending / failure / explicit retry | 必须保留占位，不把失败当无文件 | R/P | 保留原 resource 生命周期和显式重试；框高不随结果跳变 | attachments，pending 与 error 样例 |
| 长文件名、大小、来源与完整性 | 原 11px 元数据与原始 B 数字难扫读 | F/W | 元数据 12px，32px 操作区，B/KiB/MiB；完整名 title，详情保留来源 | attachments，原生产 FileCard |
| 相对图片 / 被阻止的外部图片 | 安全边界正确 | R | 保留 sanitizer 与点击外链策略，不自动读取外部图片 | attachments，最终资源清单无外源请求 |
| 输入 idle / focus / 长文 | 功能正确，但分散圆按钮与无边框输入缺乏整体归属 | P/F | 同一有界输入容器、focus-within 边界、清楚占位文字 | empty/reading，输入与多行编辑 |
| 桌面 Enter / Shift+Enter / Ctrl+Enter、窄屏 Enter、IME | 已有行为是产品契约 | R | 保留键盘与组合输入保护；不自建发送流程 | 原键盘处理与针对性回归；真实 Ctrl+Enter、当前 Chrome 的 Enter 换行与组合事件保护 |
| 发送 pending / failed / 结果未知 | 原草稿及 revision 保护正确，pending 图标反馈不足 | R/P | 保留 draft owner 和晚结果隔离；提交中标签、明确错误及单独关闭钮 | 保持请求中 / 释放结果 / 模拟失败 |
| 选择、粘贴、drop 文件 | 近期 paste/drop 是正确成果 | F/R | 原 transfer 与 generation 逻辑不变；完整 drop 提示、只暂存不发送 | 图片剪贴板 Ctrl+V、File input、DataTransfer drop |
| 暂存 uploading / ready / failed / retry / remove | 原上传与发送分离正确，失败视觉不够明确 | F/P | 名称/大小/状态行一致；失败边界、明确重试，保留移除与继续编辑 | 暂存样例、保持请求中、失败与显式重试 |
| 上传跨视图、未完成恢复、晚结果 | 不能被视觉改动覆盖 | R | 保留原 SessionDraft registry、generation、发送 acknowledgement 保护 | 现有跨会话/重挂载/晚结果测试；隔离草稿操作 |
| 语音 idle / listening / transcript / error | 有实际麦克风能力，不应忽略也不能借机重做生命周期 | R/P | 保留 provider/controller；只统一按钮、disabled 和错误提示 | lab 的合成 SpeechRecognition 回调；无麦克风采集 |
| ask 有选项 / 无选项 / 自由回答 | 需要指出正在回答问题，不是普通 prompt | G/P | 增加轻量标题、说明、pending；原 response callback 不变 | ask/freeform，全选项与自由输入回执 |
| ask allowFreeform=false | 原发送仍可能提交自由回答，与卡片提示不一致 | R | 保留草稿编辑，但阻止该请求下自由发送；选择按钮照常 | choice-only，输入后 send disabled |
| plan summary / 完整计划 / 四种动作 | 原动作集合正确；窄屏长计划会挤占阅读 | G/P/W | 保留 offered/recommended 与 supersede；正文滚动、操作区留在视野内 | plan，完整计划展开/收起、四个动作逐个调用 |
| 计划输入新指令 | 是 supersede，不是接受计划 | R | 原 sendThreadDraft 分支不变；说明保留，不造“批准”流程 | plan，输入回执为新指令分支 |
| elicitation accept / decline / cancel | 当前没有动态表单，不能虚构 | R/P | 统一工具确认标题与按钮；严格呈现 offered actions | elicitation，三个动作分别调用 |
| 队列、长文本、移除 | 与停止/打断的区别必须可见 | R/P | 保留完整 title 与每项明确移除标签，扩大移除目标 | streaming，逐项移除 |
| Stop / cancelling / cancelled | 停止会清队列，不能混同打断 | R | 保留文案及回调；原生 cancelling 标志下显示“正在停止”并禁用重复点击 | streaming/cancelling，实际停止回调后空队列 |
| 打断并继续 / pending / failure | 后台工作继续、结果未知不能假报成功 | R | 原 useKeyedAction 和原生条件不变；队列说明保留 | streaming，成功保留队列、失败明确未确认 |
| 消息操作：鼠标、键盘、触摸 | 只有右键菜单，复制不易发现 | P/C | 保留右键入口；增加可 Tab 聚焦的消息复制，触摸常显、桌面 hover/focus 显示 | reading，菜单与直接复制 |
| 初次加载 / 更早加载 | 不能误显示空会话或让 loader 推动锚点 | R | 保留初始隐藏测量、至少两屏填充及 2.5rem loader 槽 | loading/history |
| 历史失败 / stale / 部分片段 / 缺少边界 | 必须显式说明，不全量兜底 | R/P | 保留所有原条件与重读动作；改可读提示，不新增重试 | history-error/stale，显式按钮操作 |
| 空态 / 会话错误 / unloaded | 不能把 unloaded 当删除，也不能把失败当空 | R | 空态表达开始对话和目录；错误 role=alert；保留已加载阅读内容 | empty/error/unloaded |
| 手动压缩 / 回合内自动压缩 | 两者对输入的允许状态不同 | R | 原 compacting + status 判定保留；禁用态更明确 | compacting/auto-compacting |
| 上翻、流式、新消息、落底 | 单一 owner 与自然布局是硬约束 | R | threadScroll/historyPrefetch/fold 未改；新内容不抢阅读位置 | streaming，增量/追加后同锚点，新消息按钮回到底部 |
| 历史 prepend 与内容可见性 | message layout、日期和媒体不能破坏锚点 | R | 原观察器和生命周期保留；复制区在正常 flow 内被测量 | history，桌面/窄屏实际插入 |
| 标题 / 模型 / 未知模式 | 当前顶栏简洁，没必要重做 | R/P | 仅提取共享组件、补完整 title、menu expanded 语义与焦点 | 各场景生产 ChatHeader |
| 模式菜单与更多菜单 | 更多菜单已有键盘规则；模式菜单打开后焦点仍在触发器 | P/W | 更多菜单保留；模式复用 focus/dismiss 约定，当前项聚焦、方向键、Escape 返回 | 顶栏真实菜单操作 |
| readOnly 分支 | 源码仍保留，但不是恢复回收站的授权 | R | 只覆盖原分支，不增加产品入口、创建或删除契约 | readonly，输入区不存在 |

## 浏览器证据与保留项

使用 Chrome 152：先通过 Chrome DevTools MCP 逐项操作，再用同一已安装 Chrome、
现有 Puppeteer 与已配置的 sandbox，在独立浏览器 profile 中重新打开实际 React 场景，
导出原始 PNG。没有关闭浏览器 sandbox、没有另画静态产品效果图。
MCP 的文件输出受 workspace-root 配置限制，未绕去读取原生工具图片历史；
导出图片来自第二次真实浏览器渲染。

证据包中有桌面 1440×1000、窄屏 390×844、320px 极端宽度及暗色状态的截图，
以及 `browser-observations.json`。PNG 截取真实 `.chat`，不含开发控制条；
顶栏、视频详情、键盘和 clipboard 另有操作记录。
`before-*` 由本任务初始场景提交 `1ae0ee6` 的独立树实际渲染，
不是后期把新界面调差。它基于正式分支 `dee8ff6`，尚未做组件精修。
录制时用已有开发 origin 配置把基线文件指向自身预览服务。

有意保留：稳定 Markdown renderer、媒体槽与对象身份、已加载子代理事件语义、
Composer paste/drop 和 draft owner、单一 threadScroll、近顶预取、历史锚点、
完整消息替换、流式增量、所有原生操作回调与错误前置条件。
未改变 `ConnectedThread` 的请求映射、原生 store/window/fold、服务器或 MCP。

另补查待回答、上传失败、错误通知和十二行草稿同时出现的组合态：
初版在 390px 视口截断输入底部。修正 transcript 的 flex basis，允许决策区在控件叠加时
收缩并滚动，同时保留最小阅读区；不增加 JS 滚动控制器。该组合态修正后输入完整可见，
且键盘仍能到达卡片末尾选项。排队、暂存列表及通知也参与可用空间收缩并保留可操作的
最小高度，补查了运行中队列、上传失败、打断失败和长草稿叠加的情况。

后续输入栏反馈修正：单行输入栏压至 48px，底部留白减至 4px（另加设备安全区），
宽窄屏按钮均为 40×40px 正圆。文字输入区的 focus-visible 不再被通用 Chat
聚焦规则覆盖，输入时只保留外层输入栏边界；按钮自身的键盘焦点仍保留。

自动浏览器记录将流式前后、追加前后及 prepend 前后的消息 ID 与屏内 offset 一起保存。
prepend 容许不超过 1 CSS px 的浏览器 scrollTop 舍入，不把亚像素变化伪称为逐像素恒等。
检查正文、时间、工具、文件、决策与错误等实际色层叠加后的文本对比度，
目标为至少 4.5:1；disabled 与装饰图标不借此声称完整无障碍合规。

## 范围与未覆盖项

真实 Chrome 的鼠标/键盘/剪贴板操作、合成 provider、fixture 回调和既有单元测试
分别报告，不冒充生产 SDK 端到端验收。没有生产消息、生产数据、真实模型调用、
硬件麦克风/Azure、真实 iOS Safari/软键盘或屏幕阅读器认证。
移动视口与 touch media query 是 Chrome 仿真，不等于真机测试。
该主机的 headless Chrome 在宽视口也报告 `hover: none`、非 fine pointer；
因此普通 Enter 的真实结果是按既有规则换行，Ctrl+Enter 发送。
没有将它冒充精细指针桌面硬件验收；条件式 hover 的精细指针分支仍需实际设备观察。

会话信息、运行维护、模块/Task/微信业务和删除确认的内容不是本次精修对象。
场景顶栏的这些入口只记录调用意图；不制造虚拟业务流程来执行它们。
历史原生工具图片查找、动态 elicitation 表单、编辑/重生成等不存在的能力没有被添加。
未接管其他 owner 的工作树、队列或任务。

最终源码提交、最新 main 集成 SHA、针对性/全 Web 检查、生产构建以及
保留文件的下载地址以交付回执为准。**没有提交部署请求，没有重启 Cockpit 或微信。**
