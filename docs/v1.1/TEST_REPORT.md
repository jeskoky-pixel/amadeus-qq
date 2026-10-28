# v1.1 候选测试与验收记录

## 本次已验证

- `npm run build` 通过；`npm test` 共 **291 项，286 通过、0 失败、5 跳过**。跳过项含 4 项 Windows 符号链接环境能力及 1 项本地 Life 源码缺失条件。
- 回归覆盖首次配置校验与修订冲突、Owner 同源鉴权、预设/自定义、群管理默认拒绝、Scene 暂停/撤权、不同 Scene Session、Workspace 迁移、短消息合批和重启回放、可选插件缺失降级。
- 在隔离 DSH Desktop Profile 的真实 Web Console 操作首次设置、预设选择、自定义参数、撤销与保存、账号授权和深色主题。最终包还实测了全局拒绝勾选、保存、页面刷新后保持，以及另一项未保存修改的撤销。未登录的设置请求返回 401。配置持久化后重启，两个授权 Scene 的 Session ID 与 Workspace 归属保持一致；最终包复验见本报告的收尾记录。
- 真实浏览器截图：[总览](../screenshots/overview-desktop.png)、[全局设置](../screenshots/global-desktop.png)；[账号页](../screenshots/account-browser.png)与[深色主题](../screenshots/account-dark-browser.png)是合成数据布局检查，不能作为真实配置或 QQ 外发证据。公开截图已遮蔽真实测试号码与本机路径。

## 尚未验证

- 本次 v1.1 连接到真实 NapCat 的入站、模型工具外发、连续群聊自然结束、动态撤权和 Life 同时唤醒尚未完成。独立测试 NapCat 进程未能在当前已有桌面实例同时运行，隔离端口未监听。未停止或更改已有实例。v1.0 的[真实 QQ 验收](../verification/V1_REAL_NAPCAT_2026-10-27.md)只能证明当时的版本和场景。
- 窄屏响应式布局有 CSS 断点与原型参考；本次没有可复核的窄屏真实浏览器截图。其他 DSH/NapCat 版本、长期平台稳定性和日常生产账号未验收。
- “参与活跃度”是当前模型提示参数，真实模型在不同值下的参与率未测量。不能将它解释为平台级硬概率控制。

## 收尾记录

最终 `1.1.0` 包通过本地 `npm pack` 构建并重新安装到隔离 DSH Profile；已核对安装后的 `src/core.js`、`src/setup.js` 和 Web Console 脚本与工作树内容哈希一致。重新启动后，Owner 鉴权的设置/Scene/Console API 均返回 200，两个原 Scene 在 DSH Session 列表中仍保持原 Session ID 和相同 Workspace 归属，全局拒绝也写入隔离 Profile 并在重启后保留。未登录设置请求返回 401。

候选代码保持独立 QQ 仓库和隔离 DSH Profile。测试 QQ 目标均为事先授权的私聊/小群；此次没有向 QQ 群聊或私聊发送新的测试内容。未修改 DSH 核心、NapCat 本体或 Memory、Life、State 仓库；未合并和发布。
