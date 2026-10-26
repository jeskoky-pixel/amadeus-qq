# M2–M5 集中隔离 Desktop 验收（2026-10-27）

## 候选与范围

- 开发分支：codex/m0-baseline，原 Draft PR #1。
- 官方 DSH Desktop 的既有隔离 Profile，经 Plugin Manager 安装并启用 @amadeus/qq 0.1.0-qa.final；包 SHA-256：D04407D6BF069EB3AE757F7C52B377105E01930938021DBC41D43343A71F9A78。
- 隔离状态、媒体目录、Owner 工作区和本机模拟 OneBot 均位于主项目忽略的 private/qq-development/qa-final-state/。只使用合成 QQ ID、文本和媒体；未访问真实 QQ、生产 DSH Profile、生产 Bridge 或用户记忆数据。
- Codex 独立 npm test：225 通过、0 失败、4 跳过（Windows 符号链接权限）；npm run build 与 git diff --check 通过。

## 真实 Host 与模型调用

| 场景 | 结果 |
| --- | --- |
| 插件加载 | Plugin Manager 显示最终候选已启用；隔离 QQ 管理 API 为 200，连接本机模拟 OneBot 后 transport=connected，合成群和 Owner 私聊 Scene 均加载。 |
| 群管理 | amadeus-qq-media Session 的真实模型调用执行 qq_capability_execute → qq.set_group_ban。目标 50002 尚未在该群发言，插件先从绑定群调用 get_group_member_info 核实，再调用 set_group_ban；结果 delivered。 |
| 平台拒绝 | 模型执行合成群改名，模拟 OneBot 返回拒绝；工具结果为 failed、ONEBOT_REJECTED，未伪报成功。 |
| 媒体发送 | 模型调用 qq_send_media 发送受控目录内相对路径的合成 PNG，取得 delivered 和模拟消息 ID。 |
| 文件上传 | 模型调用 qq_upload_file 上传受控目录内合成文本文件，取得 delivered 和模拟文件 ID。模拟端确认收到的是临时快照路径，文件存在。 |
| Owner 工具 | 可信 Owner 私聊的 amadeus-qq-owner Session 请求头包含 qq_owner_workspace 和 qq_account_profile；模型成功读取专用目录内合成文本，并从模拟 OneBot 读取昵称、签名、在线状态。普通群请求头不包含这两个工具。 |
| 硬重启 | Desktop 硬重启后插件重新加载、同一状态文件和 Session 绑定保留。重做相同禁言 actionId 返回 delivered, repeated:true；模拟端的 set_group_ban 总调用数仍为 1。Owner 工作区与账号只读工具在重启后再次成功。 |
| 撤权 | 管理 API 更新群 Scene 权限后，旧 Session 再请求禁言收到 QQ_UNAUTHORIZED；模拟端无新的群管理调用。 |
| 收尾 | 已恢复隔离 Profile 原 connect:false 配置并硬重启核实 transport=disabled；本机模拟 OneBot 进程已停止。最终候选包保留在隔离 Profile，未部署到生产。 |

上述“真实模型调用”指官方 DSH Host 中的模型和工具运行，平台响应来自本机合成 OneBot。没有把模拟结果当作真实 QQ 投递、平台管理员权限或 NapCat 兼容性证据。本轮按用户要求暂停新增 GUI 开发；既有 Settings GUI 保留，最终候选的新文案未另做界面逐项复验。

## 仍未完成或未验证

- 未实现：通用 Owner Shell/浏览器/GitHub/插件管理，TTS、远程 ASR、头像、转发与合并转发、好友/入群申请审核、群文件管理、QZone 图片发布/可见范围/互动事件、Life 的可信 QQ Scene 唤醒及 State 联动。set_group_add_request 因缺可信申请 flag 保持不可执行；退群按设计不提供。
- 代码已有但只经单元或模拟验证：QZone loopback Provider、账号资料写后读回、媒体格式兼容、群管理员角色与更多群管理动作、真实 NapCat get_record/get_file 结果。QZone Provider 在本轮隔离 Desktop 未配置，也未连接真实账号。
- 尚无独立无头 NapCat 的真实进程与真实 QQ 账号联测；没有完成真实延迟、成功率或 QQ 风控评估。现阶段仍是开发候选，不可直接用于日常 QQ。

部署准备时应先备份独立 QQ 状态文件，确认生产 Profile 的 statePath、mediaRoot、sendRoot 和 Owner 专用目录彼此正确隔离，在真实 NapCat/QQ 的小范围测试群逐项检查读写回执与撤权。回滚采用 Plugin Manager 停用/恢复上一包及备份状态文件；unknown 外发必须先人工核对平台，不能自动重试。
