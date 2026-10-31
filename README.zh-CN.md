# Amadeus QQ

<img src="assets/market-icon.png" width="80" alt="Amadeus qq logo">

[English](README.md) · [详细配置参考](REFERENCE.md)

通过持久 DSH 会话与明确的场景权限连接 QQ。

目标发行包：**`@fg-lab/amadeus-qq@1.2.1`**。已验证的官方 DSH Desktop 基线：**0.2.1-rc.3**。许可证：MIT。

## 当前发行状态

已发布 **1.2.1**：[GitHub Release](https://github.com/jeskoky-pixel/amadeus-qq/releases/tag/v1.2.1) · [npm](https://www.npmjs.com/package/@fg-lab/amadeus-qq)。请安装固定版本；发行包校验值见 Release。后续源码修改不代表该版本安装包发生变化。

## 能帮你做什么

- 将已登录的本地 NapCat 接入获授权的群聊与私聊，每个场景在指定工作区拥有独立持久 DSH 会话。
- 用读取、等待补充、标记已读和受权限约束的发送维持当前交流；去重投递，普通配置修改保留会话历史。
- 支持代码已实现的文字、@、引用及媒体能力，逐项检查权限；依赖 Provider 的功能以实际可用状态为准。
- 选择仅观察、安全聊天、增强对话或自主群友；仅可信管理员私聊可选择 Owner Agent。全局拒绝与 QQ 平台权限始终有效。
- 在独立账号页管理资料及可选 QQ 空间能力；是否可用取决于实际 Provider 与授权。
- 暂停监听以交接给其他应用。QQ 负责当前交流，可选 Life 负责长期自主唤醒。

示例：先把测试群加入仅观察模式，确认入站正常，再切换安全聊天允许回复。通过控制台查看有效权限，不要把选择预设理解为开放全部工具。

插件不包含 NapCat，不负责其安装、登录或托管。未配置时不会外发，危险工具不默认开放。Memory、Life、State、Persona 均为可选联动，收到 QQ 消息不代表获得其他插件的私有数据权限。

## 安装与首次配置

使用官方 DSH 插件管理器将预构建 `.tgz` 安装到所需 Profile，无需手工构建源码。按[安装说明](docs/INSTALL_V1_2.md)操作，不要手工改写正在运行的 Profile。

配置 NapCat、选择工作区、填写管理员 QQ 号并逐项授权场景。建议先选择仅观察。

其他 Amadeus 插件均为可选联动，按需要分别安装。

## 界面

![Amadeus Qq 界面](docs/screenshots/product-release-20261031.png)

截图展示已有界面，不表示本轮所有真实平台能力均已通过。具体限制请阅读配置参考和验收报告。

## 升级与回滚

升级前备份用户数据。程序、持久数据和恢复备份分开保存。禁用停止功能；卸载默认保留外部数据。回退旧程序不能自动撤销数据库迁移。

- [升级政策](docs/UPGRADE_POLICY.md)
- [数据迁移与恢复](docs/DATA_MIGRATION.md)
- [发行检查清单](docs/RELEASE_CHECKLIST.md)
- [完整配置与限制](REFERENCE.md)

[项目主页](https://github.com/jeskoky-pixel/Amadeus-dsh) · [MIT 许可证](LICENSE)
