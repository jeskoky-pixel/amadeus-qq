## 1.2.1 compatibility candidate (2026-10-31)

Real official Host integration exposed reserved QQ Session IDs without the usual `session-` prefix. QQ now reserves standard `session-UUID` IDs. Life also accepts the exact legacy UUID shape for existing trusted Sessions, including its bounded wake query and configuration UI. Workspace membership, trusted Host identity, permissions and wake authorization remain mandatory. Existing IDs and history are preserved; no schema change, Session recreation or production data migration. Public distribution is pending explicit release approval.

# Amadeus QQ 发行说明

## 1.2.0 内部发行候选（未公开发布）

- 统一 `@fg-lab/amadeus-qq@1.2.0`，保留 Bundle ID `amadeus-qq`、Scene/Session 绑定、权限配置和可靠投递数据；本轮聚焦发行包与升级兼容。
- 预构建 Client、Bundle Manifest、市场图标和迁移说明已纳入候选包。隔离 DSH Desktop `0.2.1-rc.3` 所附 CLI 完成 1.1.1 → 1.2.0 的合成数据升级、重启和恢复演练。
- 本仓库经所有者确认采用 MIT；本轮发行源为公开 npm 包和固定版本 GitHub Release 包；实际发布须以最终验收结果为准。
- Desktop 图形安装、公开 Market 下载及真实 NapCat/模型联合运行仍待验收；公开发行需要单独确认。

## 1.1.1 本地交接补丁（未公开发布）

- Owner Web Console 增加“QQ 接管”开关：将同一 NapCat 登录在 Amadeus QQ 与本地 AstrBot 之间手动交接。开关经 DSH 配置服务保存并在重启后恢复，Scene 和 DSH Session 绑定不因切换而重建。
- 暂停时停止 OneBot WebSocket 接收、拒绝新的 HTTP 操作和 QQ 外发授权，并在配置重载前等待已中断操作的本地记账完成。尚未提交的旧唤醒不在恢复后重放，结果不确定的外发不自动重试。
- 控制台和 DSH 原生状态使用中文显示交接结果。真实 NapCat 与 AstrBot 的双客户端交接需在用户重装后的隔离环境实机验证。

## 1.1.0 开发基线（未公开发布）

- 六页 Owner 鉴权 Web Console 与简化的 DSH 原生设置入口。首次设置可在 GUI 选择 Workspace、NapCat、Bot、唯一 Owner、Scene 白名单和全局拒绝；Token 不回显。
- 每个授权 Scene 在选定 Workspace 中建立独立持久 Session；支持暂停、恢复、撤权和重启恢复。
- 五个权限预设及界面“自定义”状态；普通预设不再继承群管理写权限。权限保存使用修订号冲突检查，执行时继续由可信 Scene Guard 裁决。
- 当前对话可短时合批、等待补充、按权限发送或沉默；合批静默窗口从最后一条消息计时且有最长等待上限。Life 保持长期自主唤醒职责。
- 账号资料与 QQ 空间配置分离；功能中心标明源码接线、Provider 与平台验收边界。
- 本候选尚未完成 v1.1 真实 NapCat 入站/外发与 Life 并发实机验收。详见 [v1.1 测试报告](v1.1/TEST_REPORT.md)。PR #2 已合并 main；尚未公开发布或部署。

## 1.0.0

- 包版本与收缩后的 v1.0 功能范围对齐；保留包名 `@amadeus/qq` 和 Bundle ID `amadeus-qq`。本次版本收口不新增 QQ 能力。
- 持续 Scene Session、Owner Agent、五级权限和执行期 Guard、消息与附件回执、本机 NapCat 媒体/ASR、外部音频交接、账号头像与签名、QQ 空间文字/图片说说、原生 Settings 与独立 Web Console 均沿用已审查实现。
- 普通 QQ Scene 的 Memory reader 仅在 Memory 提供可信 Scene ACL 读契约时可见并执行；缺失或撤销时立即拒绝。Life 的 `externalMessageSessionIds` 只提供唤醒提示，QQ Scene Guard 负责外发授权。
- 隔离 Desktop、NapCat 与 QQ 的既有实机覆盖见 [验收记录](verification/V1_REAL_NAPCAT_2026-10-27.md)；最终包与四插件同 Profile 验收见[联合报告](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/verification/AMADEUS_V1_FOUR_PLUGIN_ACCEPTANCE.md)。未部署生产，也未公开发布。

## 范围和限制

交付范围以 [V1_SCOPE.md](V1_SCOPE.md) 为准。长期平台稳定性、任意目标外发、所有低频 QQ API、移动端视觉细节和未安装的 Host 原生工具没有同等级实机证据；不将这些作为已验证能力宣称。
