# Amadeus QQ 发行说明

## 1.0.0

- 包版本与收缩后的 v1.0 功能范围对齐；保留包名 `@amadeus/qq` 和 Bundle ID `amadeus-qq`。本次版本收口不新增 QQ 能力。
- 持续 Scene Session、Owner Agent、五级权限和执行期 Guard、消息与附件回执、本机 NapCat 媒体/ASR、外部音频交接、账号头像与签名、QQ 空间文字/图片说说、原生 Settings 与独立 Web Console 均沿用已审查实现。
- 普通 QQ Scene 的 Memory reader 仅在 Memory 提供可信 Scene ACL 读契约时可见并执行；缺失或撤销时立即拒绝。Life 的 `externalMessageSessionIds` 只提供唤醒提示，QQ Scene Guard 负责外发授权。
- 隔离 Desktop、NapCat 与 QQ 的既有实机覆盖见 [验收记录](verification/V1_REAL_NAPCAT_2026-10-27.md)；最终包与四插件同 Profile 验收见[联合报告](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/verification/AMADEUS_V1_FOUR_PLUGIN_ACCEPTANCE.md)。未部署生产，也未公开发布。

## 范围和限制

交付范围以 [V1_SCOPE.md](V1_SCOPE.md) 为准。长期平台稳定性、任意目标外发、所有低频 QQ API、移动端视觉细节和未安装的 Host 原生工具没有同等级实机证据；不将这些作为已验证能力宣称。
