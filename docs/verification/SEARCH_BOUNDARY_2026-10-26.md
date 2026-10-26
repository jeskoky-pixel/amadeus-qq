# QQ 搜索权限链隔离验收（2026-10-26）

本记录覆盖 `dsh.search` 的首个真实执行路径，不代表 QQ v1.0 最终验收。使用官方 DSH Desktop 0.2.1-rc.3 的独立 QA Profile、合成 bot/私聊 ID 和本机模拟 OneBot；没有连接或操作真实 QQ。最终已将 QA Profile 恢复为 `connect: false` 并停止模拟服务。

## 修复

- Scene 的当前 `dsh.search` 决策决定创建受限 `amadeus-qq-search` 或原 QQ-only Session。权限 revision 改变会撤销旧绑定，下一次交互创建新 Session。
- Web surface 会禁用全局 `dsh-tool-web` 行，因此搜索 preset 在自身作用域挂载官方工具，配置 `search: true`、`fetch: false`。它只增加 `web_search`，保留原生工具呈现和 QQ preset guard。
- 执行期的 preset guard 与连接器 guard 都从实际绑定 Session 读取当前 Scene 和 revision；无绑定、撤权或连接器缺席时拒绝。模型参数不能选择其他 Scene。
- 管理 GUI 的能力目录将 `dsh.search` 标为已实现；其他策略占位没有改成已实现。

## 自动化与真实 Host 证据

`npm run build` 成功，`npm test` 为 101/101，`git diff --check` 无错误。QA.37 安装包由同一源码复制打包，经官方 Plugin Manager 安装，SHA-256：`C558CF4874CBDACC4764EBAE56D2D63B26948554C848F06952593062350AEF8E`。此 QA 包只在忽略的 `private/qq-development/` 保存，未提交凭据或合成运行状态。

| 场景 | 官方隔离 DSH Desktop 结果 |
| --- | --- |
| 搜索 preset 的真实 request/header | 8 个 QQ 工具 + `web_search`；无 `web_fetch`、Shell、Memory 工具 |
| 绑定且获授权的合成私聊 Session | 模型实际调用 `web_search`，工具成功返回 |
| 管理 API 撤销 `dsh.search` | 旧 Session 再次调用 `web_search` 收到 `QQ Session search permission is not authorized` |
| 撤权后的下一条模拟 OneBot 消息 | 创建新 Session，request/header 只有 8 个 QQ 工具，无 `web_search` |
| 未绑定的搜索 preset Session | 即使 schema 中可见 `web_search`，实际调用仍被 Host guard 拒绝 |
| 硬重启后的管理 API | 私聊 Scene 的 revision 1 与 `dsh.search: deny` 持续存在；能力目录显示 `implemented: true`、`effective: false` |

## 边界

搜索仅验证官方 Host 的工具调用与当前 Scene 授权；网页结果的来源、跨 Scene 数据外发和生产网络策略尚未完成全面审计。Owner Agent 的通用 Shell/文件权限仍未实现，不能据此宣称 Memory 的绝对跨场景隔离。模拟 OneBot 不能代替独立无头 NapCat 或真实 QQ 兼容验收。PR 继续保持 Draft，不部署。
