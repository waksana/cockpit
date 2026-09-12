# Chat 输入区与用户时间戳定向返工

本轮只修改输入区几何、聚焦反馈、可视视口适配，以及用户消息时间戳的位置。
不是全站改版、原生协议变更或生产部署记录。

## 四项原因与修正

| 项目 | 原因 / 可确认事实 | 源码修正 |
| --- | --- | --- |
| 窄屏发送按钮椭圆 | 已上线对照源码 `02a1017` 在窄屏把按钮设为 36×40px，`border-radius:50%` 只会得到椭圆 | 保留此前 `5fd4c16` 的 40×40px 统一尺寸与 48px 单行输入栏。启用、禁用和提交中不改变按钮尺寸 |
| 输入时粗内框 | 通用 `.chat :is(...):focus-visible` 优先于原来的 textarea 规则；外层又有 focus-within 边界 | 保留更明确的 `.chat .chat-input-message:focus-visible` 例外，只去掉文字输入区的额外框；按钮、链接等的键盘焦点仍可见 |
| 键盘出现后未贴近可用底边 | 原 shell 只有 `100dvh`，没有监听 visual viewport；底部始终叠加设备安全区。PWA 用户截图有明显空白，但不能从位图推出 visual viewport 数值或把所有空白归给 safe-area | Shell 按浏览器报告的 `VisualViewport.height / offsetTop` 布局；仅按实际底部遮挡消耗安全区。无键盘时恢复安全区，长草稿上限随可视高度收缩 |
| 用户时间在气泡内部 | 原时间是 `.message.is-out` 内的浮动节点，附件消息又有单独时间规则 | 气泡和时间放在同一右对齐、随内容收缩的 `.user-message` 内；时间位于气泡背景外、下方 2px、右边缘对齐，不与复制按钮重叠 |

时间仍来自 `m.timestamp` 和原 `clock()`，消息 ID 仍在原气泡节点，
日期分隔、排序和助手 byline 不变。普通 prompt 附件与 ask/plan 的纯文字/选项
语义不变，暂存文件不会被偷偷变成新的 prompt 或另行发送。

## 可视视口，而非键盘高度猜测

在正常缩放下，浏览器报告：

```text
visibleTop = clamped VisualViewport.offsetTop
visibleHeight = min(VisualViewport.height, layoutHeight - visibleTop)
occludedBottom = max(0, layoutHeight - visibleTop - visibleHeight)
remainingSafeBottom = max(0, deviceSafeBottom - occludedBottom)
composerBottomGap = 4px + remainingSafeBottom
```

`layoutHeight` 使用布局视口的 `document.documentElement.clientHeight`。
这里只计算网页可见区域，不检测键盘型号、不猜键盘高度、不按设备 UA 分支。
有的浏览器同时缩小 layout/visual viewport，有的只缩小 visual viewport；
相同公式不会在已经缩小的视口上再减一次键盘高度。
部分底部遮挡只抵扣对应的安全区，不因聚焦就无条件取消所有安全区。

监听 `visualViewport.resize`、`visualViewport.scroll` 和 `window.resize`，
以一帧合并 CSS 几何写入；值不变不写 DOM。卸载移除监听、取消待执行帧并恢复原样式。
没有轮询、超时重试、原生状态副本或额外历史读取。
缩放不为 1 时冻结最近一次未缩放布局，保留浏览器的正常 pinch/pan，
不把放大后的较小 visual viewport 当成键盘而重排内容。

唯一的消息滚动写入者仍是原 `ThreadScroll`。这次适配不写 `scrollTop`、
不调用 `scrollIntoView` 或强制跟随；现有 ResizeObserver 处理布局变化后的阅读锚点。
若出现本地错误托盘，托盘与 shell 使用同一可视底边，只由最底部托盘保留安全区，
不在输入栏和托盘内重复叠加。相关面板几何同时对齐，不改变面板业务。

系统的上一项、下一项、完成工具条属于 iOS，不是网页 DOM，代码不会隐藏它。
页面只能遵循浏览器报告的可用视口；若具体系统版本把某部分系统 UI 排除或包含在
可视视口之外，仍需实际设备数据确认，不能凭一张截图反推或硬编码补偿。

参考：

- [Chrome viewport resize behavior](https://developer.chrome.com/blog/viewport-resize-behavior)：
  说明 layout/visual viewport 差别及 `interactive-widget`。现有 HTML 的
  `interactive-widget=resizes-content` 保留，但不把它当作 iOS 键盘适配保证。
- [WebKit: Designing Websites for iPhone X](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)：
  `viewport-fit=cover` 和设备安全区是不同概念，安全区不能全局删掉。

## 隔离复现入口

使用已有真实生产组件 lab，不创建原生会话：

```sh
COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev \
  --host 127.0.0.1 --port 47831 --strictPort
```

打开服务器本机
`http://127.0.0.1:47831/chat-lab.html?scene=ask&viewport=1`。
展开“场景与视口模拟”，可以输入可视高度、顶部偏移、设备安全区和缩放，
通过“应用几何事件”驱动同一生产 viewport observer。
“恢复浏览器视口”用于对照键盘收起后的安全区；
“退出模拟”恢复全部真实浏览器几何与设备安全区。

fixture 不覆盖浏览器的 `window.visualViewport`，没有模拟 iOS 键盘图片或系统工具条。
页面虚线明确标示合成可视底边，下面区域不属于该合成可视窗口。
lab 使用同一生产 shell CSS 和实际 Thread/Composer；
viewport meta 与正常入口一致。`scene=user-time` 提供短消息、
多行、文件、图片及问答回复，不使用用户截图里的私人内容。

## 分层证据与边界

| 证据层 | 实际完成 / 不作的宣称 |
| --- | --- |
| 用户原图 | owner 亲自查看；用户确认从 iPhone 主屏图标打开。椭圆、粗内框和系统工具条上方空白可见。原图未进入源码、公开 fixture 或 CI/Release |
| 源码对照 | 独立工作树的 `02a1017` 实际渲染，测到 36×40px 和 solid 内框；不是假设旧缓存 |
| 实际 Chrome | 320/390/1440px，禁用/可发/提交中、长草稿、focus/Tab；按钮 40×40px、图标中心差 0，textarea 无内框，按钮仍有焦点 |
| 等效几何事件 | layout 844、visual 420、offset 24、安全区 34：输入距报告底边 4px；恢复 visual 844 后 38px；仅遮挡 12px 时为 26px。这些数值是明确的合成输入，不是手机测量值 |
| 组合与动态变化 | 问答/计划/队列加附件与十二行草稿；横向旋转后 visual 260；缩放、浏览器实际 resize；输入底边未被裁剪。错误托盘只保留一次安全区 |
| 阅读与时间戳 | 视口开合保持同一可见消息及不超过 1 CSS px 的锚点容差；外置时间仍在消息组内参与历史布局。五类用户气泡下方间距均 2px、右边缘差 0，复制区不重叠 |
| 实机边界 | 无远程 iPhone/WebKit 设备或新的手机侧 DOM/visualViewport 测量；没有宣称 Chrome resize 等同 iOS 键盘验收。实际 PWA 上键盘动画、工具条边界仍需该设备确认 |

本轮只录制这些定向状态，不以旧的 73 张全组件图或历史测试数代替验收。
合成截图和测量数据、最终提交/集成 SHA 见本次交付附件。
**源码完成、远端集成、隔离预览、生产上线是四件事；本轮没有生产部署授权。**
