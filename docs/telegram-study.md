# Telegram Web K — 设计与交互研究(cockpit 借鉴参考)

> 来源:实地测量 web.telegram.org/k/ 运行态 + 参考 tweb 源码(GPL-3.0)。
> cockpit 接受 GPL-3.0,可直接借鉴;需在仓库加 LICENSE(GPL-3.0)+ 对 tweb 署名。
> 本文记录「学什么、为什么好、怎么落地到 cockpit」。

## 一、信息组织(它最强的地方)

1. **三栏渐进式布局**:左=会话列表 / 中=当前对话 / 右=信息面板(浮层)。
   响应式三档(源码 mediaSizes.ts):
   - `≤600px` = mobile:单栏,列表↔对话**滑动切换**
   - `≤925px` = medium:左栏作**浮层抽屉**盖在对话上
   - `≤1680px` = large:左栏**停靠**与对话并排;`>1680` 才显示第三栏
   - cockpit 现在是两档(master-detail),可借鉴 925 这条「浮层↔停靠」线。

2. **会话行信息密度**:72px 高,头像左、标题+时间一行、最后消息+未读徽章一行。
   一行能读出:谁、说了什么、何时、几条未读、是否静音/置顶/已读(✓✓)。
   cockpit 行可借鉴:把 status 文字换成更克制的图标/徽章语义。

3. **克制的层级**:列表是图案背景上的**圆角悬浮卡**(radius 24px),
   选中项整条主色蓝底白字——选中态极其明确,无歧义。

## 二、为什么好(可直接借鉴的设计决策)

| 维度 | Telegram 做法 | 借鉴到 cockpit |
|---|---|---|
| 操作入口 | 右键(桌面)+ 长按(移动)统一上下文菜单;滑动是移动快捷方式 | 已照此实现 |
| 破坏性操作 | Delete 红色 + 置菜单底部 + 图标;不弹确认,靠可逆性 | 已用红色置底;cockpit 用 Undo 替代确认 |
| 菜单动画 | 从光标最近的角展开(transform-origin 跟随),0.2s scale+fade | 可加:菜单按象限设 transform-origin |
| 菜单质感 | 半透明白 + backdrop-filter: blur(50px),radius 16px,投影柔 | 可借鉴毛玻璃 + 16px 圆角 |
| 选中态 | 整条主色填充,白字(不是淡 tint) | cockpit 当前是淡 tint,可考虑加强 |
| 排序 | 按真实活动时间,置顶项单独区 | 已修;可加「置顶」 |

## 三、设计 token(实测值,可直接用)

- 缓动:--transition-standard-easing: cubic-bezier(.4, 0, .2, 1)(几乎所有动画)
  进场 .3s / 出场 .25s;菜单/层 .2s。
- 字号阶梯:10/11/12/13/14/15/16/18/20/24 px(--font-size-N),正文 16,次要 14,时间 12。
- 行高:正文 1.3125。
- 圆角:主栏/输入框 24px,菜单/气泡 16px。
- 颜色:主色 #3390ec;hover 底 rgba(112,117,121,.08);
  选中 #3390ec;未读徽章蓝底白字 radius 10px,min-width 20px,font 12px。
- 字体:Roboto 优先,fallback -apple-system/系统。

## 四、移动端适配(cockpit 最该学的)

1. --vh 而非 100vh:JS 算 innerHeight*0.01 写入 --vh,
   高度用 calc(var(--vh)*100)。规避移动浏览器地址栏/键盘导致的 100vh 抖动。
   (cockpit 现用 100dvh 是这套的现代 CSS 等价物,基本够;iOS 老版仍可回退 --vh。)
2. viewport meta:width=device-width,initial-scale=1,maximum-scale=1,
   user-scalable=no,shrink-to-fit=no,viewport-fit=cover
   —— maximum-scale=1 + user-scalable=no 防止聚焦输入框时 iOS 自动放大;
   viewport-fit=cover 适配刘海/安全区。cockpit 可补 viewport-fit=cover。
3. 列表↔对话滑动:mobile 档单栏,用 transform 滑动切换(非重新挂载),
   配 --slide-header-transition: .4s ease-in-out。
4. 触摸检测:html.no-touch / 有触摸时不同——hover 效果只在 no-touch 下启用
   (cockpit 已用 @media (hover:none) 区分滑动 vs hover×)。

## 五、键盘弹出处理(重点)

1. Safari sticky-input hack(fixSafariStickyInput.ts):聚焦输入框前先
   input.style.transform='translateY(-99999px)' -> focus() -> doubleRaf 后还原。
   规避 iOS Safari「聚焦输入不滚动到位 / 粘滞」的老 bug。
   -> cockpit 的语音/输入框聚焦若在 iOS 有跳动,可加这个 hack。
2. 键盘高度:visualViewport resize -> 重算 --vh,内容区随之收缩,
   输入框始终贴可见视口底(cockpit 现用 fixed + 100dvh + interactive-widget=resizes-content,
   思路一致;可考虑加 visualViewport 兜底)。

## 六、对话区(顺带学到)

- 气泡:白色圆角(16px),时间在气泡内右下角(图片上时浮 rgba(0,0,0,.35) 底)。
- 日期分隔:居中半透明深色胶囊「Today」。
- 输入框:圆角胶囊,左=附件,右=emoji + 麦克风;输入时麦克变发送(cockpit 已有雏形)。
- 背景:图案 wallpaper(cockpit 不必照搬,保持 Solarized)。

## 七、落地清单(cockpit backlog)
- [ ] 上下文菜单:毛玻璃 + 16px 圆角 + 从光标角展开动画 + 图标
- [ ] 断点加 925「浮层↔停靠」中间档
- [ ] viewport 补 viewport-fit=cover;评估 iOS sticky-input hack
- [ ] 会话行:未读徽章(蓝底白字 radius 10) + 静音/置顶图标语义
- [ ] 选中态加强(整条主色 vs 当前淡 tint)——待用户定
- [ ] 置顶(pin)会话单独区
