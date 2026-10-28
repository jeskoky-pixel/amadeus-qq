# Amadeus QQ 发行说明

## 1.1.0 候选

- 六页 Owner 鉴权 Web Console 与简化的 DSH 原生设置入口。首次设置可在 GUI 选择 Workspace、NapCat、Bot、唯一 Owner、Scene 白名单和全局拒绝；Token 不回显。
- 每个授权 Scene 在选定 Workspace 中建立独立持久 Session；支持暂停、恢复、撤权和重启恢复。
- 五个权限预设及界面“自定义”状态；普通预设不再继承群管理写权限。权限保存使用修订号冲突检查，执行时继续由可信 Scene Guard 裁决。
- 当前对话可短时合批、等待补充、按权限发送或沉默；合批静默窗口从最后一条消息计时且有最长等待上限。Life 保持长期自主唤醒职责。
- 账号资料与 QQ 空间配置分离；功能中心标明源码接线、Provider 与平台验收边界。
- 本候选尚未完成 v1.1 真实 NapCat 入站/外发与 Life 并发实机验收。详见 [v1.1 测试报告](v1.1/TEST_REPORT.md)。PR 不合并、不发布。

## 1.0.0

- 包版本与收缩后的 v1.0 功能范围对齐；保留包名 `@amadeus/qq` 和 Bundle ID `amadeus-qq`。本次版本收口不新增 QQ 能力。
- 持续 Scene Session、Owner Agent、五级权限和执行期 Guard、消息与附件回执、本机 NapCat 媒体/ASR、外部音频交接、账号头像与签名、QQ 空间文字/图片说说、原生 Settings 与独立 Web Console 均沿用已审查实现。
- 普通 QQ Scene 的 Memory reader 仅在 Memory 提供可信 Scene ACL 读契约时可见并执行；缺失或撤销时立即拒绝。Life 的 `externalMessageSessionIds` 只提供唤醒提示，QQ Scene Guard 负责外发授权。
- 隔离 Desktop、NapCat 与 QQ 的既有实机覆盖见 [验收记录](verification/V1_REAL_NAPCAT_2026-10-27.md)；最终包与四插件同 Profile 验收见[联合报告](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/verification/AMADEUS_V1_FOUR_PLUGIN_ACCEPTANCE.md)。未部署生产，也未公开发布。

## 范围和限制

交付范围以 [V1_SCOPE.md](V1_SCOPE.md) 为准。长期平台稳定性、任意目标外发、所有低频 QQ API、移动端视觉细节和未安装的 Host 原生工具没有同等级实机证据；不将这些作为已验证能力宣称。
