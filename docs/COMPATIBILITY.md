# Amadeus QQ 1.0.0 兼容性

| 对象 | 本轮基线 | 契约 |
| --- | --- | --- |
| DSH Desktop | 隔离实测 `0.2.1-rc.3` | 使用官方 Session、工具、Settings、Plugin Manager 和 Cordis 服务；其他 DSH 版本需隔离复验。 |
| Node.js | `>=22.13.0` | 遵循 `package.json` 的 `engines`。 |
| 本机 NapCat | 现有 OneBot 11 接口 | 默认 `enabled:false`、`connect:false`；启用前需管理员配置授权 Bot、Scene 与独立状态路径。 |
| Life | 可选，1.0.1 | 只消费受控 Wake 所在 DSH Session；Life opt-in 不取代 QQ 执行期权限。 |
| Memory | 可选，1.0.0 | 普通 QQ Scene 的三个 `memory_*` reader 依赖 [可信 Scene ACL 契约](contracts/qq-memory-scene-acl-v1.md)，缺失时安全拒绝。 |
| State | 可选，1.0.0 | QQ 无硬依赖；State 不提供 QQ 权限或独立 Persona。 |

插件包名为 `@amadeus/qq`，Bundle ID 为 `amadeus-qq`。Life、Memory、State、QQ 各自保留独立安装、状态和回滚路径；不共享 SQLite 文件。QQ 不创建第二个主 Agent 或人格。
