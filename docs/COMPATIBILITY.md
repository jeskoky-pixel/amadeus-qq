# Amadeus QQ 1.1.1 开发基线兼容性

| 对象 | 本轮基线 | 契约 |
| --- | --- | --- |
| DSH Desktop | 隔离实测 `0.2.1-rc.3` | 使用官方 Session、工具、Settings、Plugin Manager、Config Editor 与 Workspace 服务；其他 DSH 版本需隔离复验。 |
| Node.js | `>=22.13.0` | 遵循 `package.json` 的 `engines`。 |
| 本机 NapCat | 现有 OneBot 11 接口 | 首次 GUI 配置本机 HTTP/WS、Token 与授权 Scene；v1.1 候选未重新完成真实入站/外发验收。 |
| Life | 可选，1.1.0 | 只消费受控 Wake 所在 DSH Session；Life opt-in 不取代 QQ 执行期权限。交接暂停时 QQ 外发授权会拒绝。 |
| Memory | 可选，1.0.1 | 普通 QQ Scene 的三个 `memory_*` reader 依赖 [可信 Scene ACL 契约](contracts/qq-memory-scene-acl-v1.md)，缺失时安全拒绝。 |
| State | 可选，1.1.0 | QQ 无硬依赖；State 不提供 QQ 权限或独立 Persona。 |
| Persona | 可选，0.1.0 | 通过可信 QQ Scene 映射选择表达风格；暂停交接时没有新的 QQ 消息唤醒。 |

插件包名为 `@amadeus/qq`，Bundle ID 为 `amadeus-qq`。五个插件各自保留独立安装、状态和回滚路径；不共享 SQLite 文件。QQ 不创建第二个主 Agent 或人格。

1.0 状态文件可沿用；新 Workspace 绑定会撤销旧 Session 并建立新绑定。先备份独立 QQ 状态与 DSH Profile，再按[升级说明](v1.1/UPGRADE.md)操作。

1.1.1 的 QQ 接管开关沿用现有 `connect` 配置；仅切换连接不更改 Workspace、Scene 白名单或 Session 安全指纹。真实 NapCat 与 AstrBot 轮流接管尚待本机验收。
