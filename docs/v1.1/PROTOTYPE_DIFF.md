# HTML 原型与实际 Web Console 对照

设计参考来自用户提供的 `amadeus_qq_v1_1_console_handoff.zip`。原型是静态交互稿；产品页面由插件自身静态资源及受 DSH Owner 鉴权的 Admin API 驱动。

| 原型 | v1.1 实现与差异 |
| --- | --- |
| 六类导航、卡片布局、浅色/深色主题 | 已在真实 Web Console 实现。图标与细节并非逐像素复制，以当前插件状态为准。 |
| 首次设置、Scene 管理 | 真实 Workspace、Bot/Owner、NapCat、白名单与全局拒绝配置；Session ID 来自 DSH。没有硬编码演示数据。 |
| 预设与自定义 | 改动任一权限/行为参数立即显示自定义；保存使用修订号冲突检查；实际生效权限由后端返回。 |
| 功能中心 | 显示源码已接线、Provider 条件与待平台确认状态，不把 NapCat 动作目录当作已验证能力。 |
| 账号/空间 | Owner 授权与 QZone Provider 分开保存；账号级能力不放在普通 Scene 编辑器。 |
| 诊断 | 展示连接、Workspace、Scene 与 Session 绑定。原型中的演示指标、模拟日志或安全测试按钮未照搬为假数据。 |
| 窄屏布局 | 保留响应式 CSS；真实窄屏浏览器视觉证据仍待补充。 |

界面当前不内置 NapCat 安装器或二维码登录器。用户可在 DSH GUI 完成 QQ 插件配置，但 NapCat 本体仍需按其官方方式安装和登录。v1.1 的真实平台闭环待隔离 NapCat 可用后复验。
