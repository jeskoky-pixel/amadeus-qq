# Amadeus QQ 1.2.0（发行候选）

此候选版提供预构建 DSH Bundle，可从隔离的 DSH 插件管理器安装 `.tgz`。已在官方 DSH Desktop `0.2.1-rc.3` 附带的运行时验证；公开 npm 与市场收录尚未执行。安装、升级、卸载和数据保留见 [v1.2 安装说明](docs/INSTALL_V1_2.md)、[升级政策](docs/UPGRADE_POLICY.md) 与 [数据迁移](docs/DATA_MIGRATION.md)。此前 1.1.1 的验收记录保留在下文。

Amadeus QQ 是独立的 DeepSeek Harness 插件，通过本机 NapCat/OneBot 连接 QQ。每个授权群聊或好友私聊使用一个持久 DSH Session；消息读取、模型工具外发、媒体、回执与权限检查均留在插件内。Memory、Life、State 是可选联动，QQ 单独安装也能处理当前对话。

## 首次使用

1. 在 DSH Desktop 的插件管理器安装 `@amadeus/qq` 包。打开插件设置页，进入受 DSH Owner 鉴权保护的 Web Console。
2. 在“全局设置”选择已有 DSH Workspace，填写 Bot QQ 号、唯一 Owner QQ 号、本机 NapCat HTTP/WebSocket 地址及需要的 Access Token。Token 保存后不回显。
3. 添加授权群号或好友 QQ 号；Owner 私聊自动加入白名单。保存并应用，按页面提示连接 NapCat。
4. 到“会话管理”选择预设，查看每项**实际生效**的权限，保存。授权 Scene 会在所选 Workspace 中建立独立 Session；可暂停、恢复或移出白名单。
5. 到“运行与诊断”检查连接、授权和 Session 状态。账号资料与 QQ 空间的授权位于独立的“账号与 QQ 空间”页。

默认的普通预设不授予群管理写权限。手工修改权限或行为参数会显示“自定义”；重新选择预设会覆盖该 Scene 的整套预设。“全局设置”可管理对所有 Scene 生效的全局拒绝。可信 Owner、Scene 白名单和 QQ 平台权限始终优先。模型只能通过受控 QQ 工具发送消息，普通文本输出不会自动外发。

## 与本地 AstrBot 轮流使用同一个 QQ

只运行一个登录该 QQ 号的本机 NapCat。Amadeus QQ 与 AstrBot 可以配置同一 NapCat 的本机 OneBot 地址和各自所需的 Token；同一时间只让一方接管消息。在 Amadeus QQ Web Console 的“全局设置 → QQ 接管”点击“暂停 Amadeus，交给 AstrBot”，确认页面显示“已暂停”后再启动 AstrBot。切回时先停用 AstrBot，再点击“恢复由 Amadeus 接管”。开关仅由 DSH Owner 操作，状态保存在 DSH 配置中，重启后仍有效。

暂停会断开 Amadeus 的 WebSocket 接收并拒绝新的 OneBot HTTP 操作、QQ 模型工具外发和 Life 经 QQ 的发送授权；已有 Scene、DSH Session 与历史消息保留。交接前已提交给 NapCat 的请求可能已经执行，无法撤回，结果不确定的动作不会自动重发。AstrBot 接管期间的消息不会自动补入 Amadeus；交接时尚未发起的旧 QQ 唤醒也不会在恢复后延迟回复。

## 页面与架构

Web Console 有总览、会话管理、功能中心、账号与 QQ 空间、全局设置、运行与诊断六页，支持浅色和深色主题。原生 DSH 设置页仅提供状态与入口。短消息可在有上限的静默窗口内合批；Agent 可等待补充、分条发送或保持沉默。QQ 不拥有长期自主唤醒或冷场定时调度，长期活动由可选的 Life 插件负责。

功能中心区分源码接线、Provider 配置与实际平台可用性；显示“源码已接线”并不代表已在所有 NapCat 版本实机验证。QQ 空间依赖单独 Provider。

## 验证与当前边界

`npm run build` 和 `npm test` 可检查安装包及回归测试。v1.1.1 完整回归为 **303 项：298 通过、0 失败、5 跳过**。隔离 DSH Desktop 已验证 GUI 首次设置、Owner 鉴权、Workspace 内的双 Scene Session、权限编辑、暂停和重启恢复。新交接开关尚未在重装后的真实 NapCat 与 AstrBot 上完成实机切换；[v1.0 真实 QQ 验收](docs/verification/V1_REAL_NAPCAT_2026-10-27.md)只能作为既有能力的历史证据。此次合并仅作为个人电脑实机测试基线，不代表生产部署许可。

- [v1.1 测试报告](docs/v1.1/TEST_REPORT.md)
- [1.1.1 本地 AstrBot 交接验收](docs/verification/QQ_ASTRBOT_HANDOFF_2026-10-29.md)
- [四插件联合验收与未完成项目](docs/verification/FOUR_PLUGIN_V11_JOINT_2026-10-28.md)
- [权限预设矩阵](docs/v1.1/PRESET_MATRIX.md)
- [升级说明](docs/v1.1/UPGRADE.md)
- [原型差异](docs/v1.1/PROTOTYPE_DIFF.md)
- [发行说明](docs/RELEASE_NOTES.md)与[兼容性](docs/COMPATIBILITY.md)

## 开发与隐私

仅在隔离 Profile 和授权测试 QQ 场景验收。不要将生产 DSH Profile、NapCat、QQ Bridge、Memory/Life/State 数据或真实 Token 加入仓库。`npm pack` 生成本地安装包；此仓库不自动发布或部署。项目总览见 [Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。

Persona 等可信 Host 插件可使用只读的 [已授权 Scene 发现契约](docs/PERSONA_SCENE_CONTRACT.md) 在首条消息前配置场景；QQ 白名单与发送权限仍由 QQ 插件管理。
