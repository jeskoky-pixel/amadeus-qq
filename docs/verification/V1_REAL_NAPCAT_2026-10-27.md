# v1.0 真实 NapCat/QQ 与隔离 DSH 验收（2026-10-27）

## 环境和安全边界

- 候选：`codex/m0-baseline`，原 Draft PR #1。隔离 DSH Desktop Profile 安装 QA 包；真实 NapCatQQ Desktop 使用独立 `NCD_DATA_ROOT` 和测试 Bot。生产 DSH Profile、QQ Bridge、Memory/Life 数据未作写入。
- 用户授权的外发对象包括一个指定测试私聊，以及一个仅含 Owner QQ 与测试 Bot 的授权群；测试期间未向其他群或个人发送。头像、签名和 QQ 空间操作仅作用于登录的测试账号。
- 真实测试结束后，QQ 插件已停用、隔离 Profile 配置恢复 `connect:false`；测试 NapCat Desktop、BootMain 和 QQ 进程已停止。原 SnowLuma Bot 配置在测试前后哈希一致。Life 受控外发与 Memory 停用 UI 检查使用独立隔离环境，不改变生产配置。
- NapCat 数据根独立，但 QQ 客户端媒体缓存仍共用系统 `Documents/Tencent Files`；不把此环境描述为客户端级完全隔离。私聊正文、消息 ID、空间 tid、Token、Cookie 和头像原件只保留在忽略的本地 QA 目录，不进入 Git 或安装包。

## 实际结果

| 场景 | 证据级别与结果 |
| --- | --- |
| 连续交互与 Owner | 隔离官方 DSH 模型实际调用 QQ 工具及原生 `pwsh`、`read`，完成本机只读任务；可信 Owner 私聊可见，普通 Scene 的可见性和执行期授权有回归。原 M1 多阶段发送、等待续接、撤权及硬重启见既有隔离 Desktop 报告。 |
| 真实入站 | NapCat `get_login_info` 成功；收到指定私聊的真实文字、图片和 `record`；`get_msg`/`get_record` 结构与插件读取路径核对。 |
| QQ 原生转写 | `fetch_ptt_text` 对真实语音首次暂时失败，随后返回非空文本。隔离 DSH 模型经 `qq_transcribe_message_record_native` 获得转写及正确原消息、发送者和私聊 Scene；硬重启后关联仍在。失败路径不编造转写。 |
| 真实外发 | 隔离 DSH 模型向授权私聊发送文字、图片、MP3 语音，插件返回 `delivered` 与消息 ID；NapCat `get_msg` 读回对应 `text`、`image`、`record` 段。 |
| 群聊发送 | 在仅含 Owner 与测试 Bot 的授权群，真实隔离模型调用 @+face、回复、回应、戳一戳和群附件发送工具，均返回 delivered；NapCat `get_msg` 复核到 @、face、reply 段，群文件根目录确认一个上传文件。 |
| 群附件回执 | NapCat 群文件列表会轮换 `file_id`，最终代码改用稳定元数据/计数并在歧义时保留 unknown。最终包与隔离 Desktop 重启后，新群附件返回 delivered，平台恰有一个匹配文件，回执经 `get_group_file_url` 解析；列表 ID 与上传时不同。旧的 unknown 上传没有被重试或改写。 |
| 账号资料 | 模型工具修改测试号签名和头像成功；签名读回，头像经平台外部接口读回测试图。两者已恢复原内容。头像经 QQ 平台重编码，恢复后视觉一致但字节哈希不同。 |
| QQ 空间 | `qq_qzone` 用 `audience:self` 发布文字和图片说说，均返回 tid；两个测试 tid 随后通过 NapCat 删除。其他可见范围及互动动作未作真实平台验收。 |
| 重启持久性 | 隔离 DSH 硬重启后复用相同私聊和空间 `actionId`，返回 `repeated:true`；私聊历史中测试文字只有一条。 |
| 管理 Web Console | 最终包在隔离 Desktop 的真实浏览器中加载，显示授权群/私聊、Bot 与已观察 QQ ID 的场景图；节点点击、筛选和重置均可用，权限编辑器保留，owner admission 与 CSP 不变。停用 Memory Bundle 后同一 UI 仍加载并显示授权 Scene 拓扑，确认运行时不依赖 Memory；Memory 自身实体 UI 是独立 Mneme 视图，本轮隔离库为空，未绘制新的语义图数据。窄屏由横向滚动及更窄时的列表回退处理，未做移动端视觉回归。 |

## 收尾质量修复与同 Host 联动

- QQ Connector 的全局执行 guard 曾将 Owner Preset 已开放的动态注册工具再次拒绝。新增失败回归后修复：只有当前绑定、仍处于 Owner Agent 模式的可信管理员私聊，才能调用 Host 中已注册的非 QQ 工具；`run_code`、未知工具、普通私聊和群聊仍拒绝。隔离官方 DSH 中，全新合成 Owner Session 实际调用 `life_intent_create` 成功；旧 Owner Scene 经管理 API 降为 Safe Chat 后，旧 Session 再调用 `web_fetch` 得到执行期拒绝。Owner 的 `web_fetch` 在撤权前也完成一次真实 Host 只读调用。该隔离 Host 未安装 GitHub 工具，因此不宣称 GitHub 实调。
- QQ 与 Memory 在同一隔离官方 DSH Host 中，使用合成标记和真实绑定的群/私聊 Session 验收 runtime context。精确查询命中了私聊标记，未观察到其他 Scene 的注入；初始宽泛私聊查询未召回该标记，因此不宣称通用 Memory 检索完备。原始 Session ID、标记及记忆内容只留在忽略的私有 QA 目录。
- Life 1.0.1 候选代码在同一隔离 Host 使用独立数据库与唯一 Owner Session 允许名单。模型工具创建的 intent 持久化了 `life-tool:session:<当前 Owner Session>` 授权来源；管理员对同一 allowlist Owner Session 与授权 QQ 私聊开启 `externalMessageSessionIds` 后，Life wake 执行，模型在该 Scene 恰好一次调用 `qq_send_message`，QQ 工具返回 delivered，NapCat `get_msg` 与指定 Owner 好友历史确认了 Bot 的私有文字。首次尝试曾暴露错误的 provenance 检查且没有发送任何 QQ 消息；Life 源码随后改为读取持久 intent，而不是 wake/binding 授权。关闭 opt-in 后，另一条全新工具授权 intent 的 wake 使用显式非发送提示，模型零次 QQ 发送。该 opt-in 只改变提示指导，不是 Life 级外部工具硬闸门；QQ Scene 的执行权限仍是权威。最终 1.0.1 版本包已在同一隔离 Desktop 安装并硬重启，健康状态正常；完整外发行为测试使用相同运行时代码的独立 QA 包，未重复外发。
- 入站 `get_image` 现在限制平台响应体大小，并仅接受受控本地路径或 canonical、有界的内联 base64 图片；`get_file` 超限路径也有回归。内联图片分支为单元/模拟证据，未声称真实 NapCat 返回过该形态。
- QA 收尾后 QQ 和 Life Bundle 均停用，隔离 Profile 恢复 `connect:false` 且无 Life 配置行，QQ 合成状态恢复测试前备份；测试 NapCat 仍停止。受控外发与 Memory 停用 UI 检查另在隔离环境完成，未改生产；生产 DSH、SnowLuma、QQ Bridge、Memory/Life 数据未修改。

## 代码门禁与安装产物

- `npm test`：264 通过、0 失败、4 跳过。四个跳过项均因本机 Windows 无法创建符号链接，不是外部服务缺失。
- `npm run build`、打包与 `git diff --check` 通过。
- `npm pack` 的脱敏产物不含私有 QA 状态和真实凭据；包哈希与安装记录以交付消息为准。同代码包已在隔离 DSH Desktop 安装并经硬重启加载；最终包安装后 QQ 连接保持关闭。

## 尚未验证及部署建议

- Memory 的 Scene 隔离在本轮只验证了合成标记下的精确命中/无跨 Scene 注入，宽泛查询未召回，不能宣称检索完备。State 没有稳定运行源码，仅验证可选降级。Life 受控外发已有一次完整证据，但 opt-in 只改变提示指导、不是 Life 级硬闸门；长期自治与任意 QQ 目标仍未验证。
- GitHub 工具、QQ 空间互动、其他可见范围、移动端视觉回归和长时间真实平台稳定性未逐项实测；对应功能保留源码及单元/模拟证据。群发送、@/face/reply、回应、戳一戳和群附件回执已有授权群实机证据。
- 生产准备应先备份独立 QQ 状态文件，逐项确认 bot/owner/Scene 白名单、NapCat Token、媒体根目录及权限上限，再对授权私聊/小群灰度。群附件注意 NapCat 会轮换 `file_id`，以稳定元数据和文件计数核对；unknown 投递只人工对账，不自动盲重试。回滚时停用 QQ Bundle、恢复上一安装包和隔离备份状态；不改动生产 QQ/Memory/Life 数据。Life 受控外发只能经管理员 opt-in、授权 QQ Scene 和明确目标使用，QQ 执行权限仍是权威；opt-in 不是硬性禁止层。
