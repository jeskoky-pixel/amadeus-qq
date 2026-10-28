# Amadeus 四插件 v1.1 联合验收记录（2026-10-28）

## 候选版本与范围

同一隔离 DSH Desktop Profile、同一官方 DSH Workspace 中启用 QQ 1.1.0、Memory 1.0.1、Life 1.1.0、State 1.1.0。生产 DSH Profile、生产记忆库、生产 NapCat 和 Life 数据未参与本轮测试。四个 PR 均保持开放，未合并、未发布。

## 已验证

| 项目 | 证据 | 结论 |
| --- | --- | --- |
| QQ 会话连续性 | 完整测试 295 项：290 通过、0 失败、5 跳过；本轮定向 53/53 通过。隔离 Owner GUI 修改群场景静默窗口、新增无关白名单场景，原群 Session ID 均未改变；移除临时场景后原测试群仍在。 | 普通行为和无关白名单修改不再撤销现有绑定；权限与 Agent Preset 安全切换仍撤权。 |
| Memory 可信身份 | 完整产品测试 714/714 通过；最终近期活动核心与运行时定向 37/37 通过。跨 Session 授权通过 Host `sessions.get(id)` 取得完整 Session Header；运行时另从可信 QQ Host 实时核对源、目标 Scene。QQ Host 对普通 Session 抛出的未绑定异常由完整 Host Header 中的已知普通 Preset 确认，未知/QQ Preset 继续拒绝。无关 QQ Scene、QQ→普通及普通→QQ 均拒绝。旧库已有的非法分享策略也在读取时拦截；撤销 Host 绑定立即失效。 | 先前 `{id}` 与可信 Header 契约冲突及原始近期摘要跨 Scene 授权缺口均已修复，未放宽 QQ Scene 边界。 |
| Memory 包名与升级 | `@amadeus/memory@1.0.1` 已用于包名和发行补丁；插件 ID 仍为 `dsh-mneme`，默认数据路径不变。源码及 tarball 隐私检查通过。安装文档写明两个 QQ Scene 开关及旧库隔离副本迁移。 | 旧配置沿用；升级时必须停用旧包，避免双实例。 |
| 同 Profile 联动 | 四插件同时在隔离 Desktop 响应各自 Owner HTTP 接口。QQ、Memory、Life、State 均绑定同一官方 Workspace；重启后绑定保留。State 与 Life 的 Workspace 列表均包含已授权 QQ 群聊及私聊 Session。 | 未观察到 Host 端点冲突；跨插件 Session 成员识别正常。 |
| Memory Scene 开关 | 在隔离 Owner 设置接口启用 `sceneIsolationEnabled`、`sceneStrictQQ`、`recentActivityEnabled`，硬重启后近期活动运行、两个 Scene 开关生效。 | QQ 记忆首次配置要求已明确，运行配置可持久恢复。 |
| 真实 DSH 模型与近期活动 | 清除旧浏览器确认框后，在隔离 Desktop 现有 QQ 私聊与群聊 Session 各完成一次最小模型调用；Memory 近期活动总数为 2，各 Session 的自读预览各返回 1 条。过期、无 QQ Host 绑定的 Session 仍拒绝。NapCat 连接保持关闭。 | 实际模型事件到 Memory 的自 Scene 近期活动链路通过；没有发生 QQ 外发。 |
| 普通 DSH Session 真实分享 | 通过官方 `session/create({workspaceId, agentPreset:'standard'})` 在同一 Workspace 新建两个 Session，使用 OpenCode Go DeepSeek V4.1 Flash 各完成真实模型回合。Memory Owner API 将源策略设为 `shared` 后，目标的 `include_self=false` 预览返回源 Session 的 2 条近期摘要；策略改回 `self` 后立即返回 0。首次仅传 `cwd` 的两个 Session 未进入 Workspace，已按官方 API 契约改用 `workspaceId`。 | QQ Host 存在时普通 DSH Session 的跨 Session 链路已实机通过；没有依赖手改数据库或 Profile。 |
| 最终 Memory 候选包 | `@amadeus/memory@1.0.1` tarball SHA-256 `1f036ff38687c6ef735b5089f1f0c851c84772978dc7f5dedf5e80403005eb32`，源码/发行包隐私检查通过；官方 Plugin Manager 在同一隔离 Profile 安装结果 `application=applied`。安装目录含最终配对授权代码；硬重启后四插件的 Owner HTTP 接口均返回 200。 | 最终候选已落在隔离 Profile 并恢复加载；这不等于隔离 NapCat 的端到端测试。 |

## 尚未通过的真实环境验收

1. 官方 DSH `SessionStore.get(id)` 只返回活跃 Session。隔离 Desktop 重启后，休眠会话的近期活动策略更新安全拒绝 `session-identity-unavailable`；两个 Session 再次完成模型回合、变为活跃后真实分享通过。因此“休眠的持久 Session 无须激活便能继续跨 Session 分享”尚未实现。若要支持，须引入 Host 可信的持久 Header 解析契约，不能回退到 `{id}` 授权。
2. 隔离 NapCat 测试端口未监听。运行中的 NapCatQQ Desktop 无隔离数据目录标记，不能确认是否为生产实例；隔离 QQ 状态为 `transport=disabled`，Life 外发为 `delivery=disabled`。本轮未连接或向 QQ 外发。因此连续对话实机、Life 自主唤醒与 QQ 去重、真实 QQ 长期记忆和权限撤销后的外发阻断仍待同一隔离测试实例复验。
3. 浏览器中旧 QQ 控制台的 JavaScript 确认框已从 Windows 窗口取消，GUI 可继续操作。普通 DSH Session 分享随后通过官方 DSH API 完成真实模型验收；普通用户全路径 GUI 复测仍待完成。
4. Memory 的真实 Embedding 检索、State 自动演化、Life 定时唤醒及四插件组合下的性能未在本轮重测。上述功能已有各自测试，本轮报告不扩大其真实环境结论。

## 本轮问题清单与处理

- 已修复：QQ 的普通配置变更导致无关 Session 重建；安全变更仍按原权限边界撤权，旧会话历史保留。
- 已修复：Memory 跨 Session 近期活动的 ID-only 授权与 QQ Host Header 契约冲突。
- 已修复：Memory 原始近期摘要的分享策略只分别校验源/目标、未校验二者 Scene 关系。最终包对策略写入、旧策略读取及动态撤权均加可信 Host 配对闸门。
- 已修复：QQ Host 对未绑定的普通 DSH Session 抛错时配对闸门误拒绝普通分享；改为使用可信 Session Header 判定已知普通 Preset，并在隔离 Desktop 复现、修复、验证。
- 已完成：Memory 发行名、版本、兼容测试和首次配置/旧库迁移说明。
- 待验收：休眠持久 Session 的可信 Header 解析、隔离 NapCat 联合实机、浏览器 GUI 与模型工具调用。四个 PR 在这些项目确认前不合并、不发布。
