# v1.0 真实 NapCat/QQ 与隔离 DSH 验收（2026-10-27）

## 环境和安全边界

- 候选：`codex/m0-baseline`，原 Draft PR #1。隔离 DSH Desktop Profile 安装 QA 包；真实 NapCatQQ Desktop 使用独立 `NCD_DATA_ROOT` 和测试 Bot。生产 DSH Profile、QQ Bridge、Memory/Life 数据未作写入。
- 用户授权的外发对象仅为一个指定测试私聊。测试期间未向任何群发送。头像、签名和 QQ 空间操作仅作用于登录的测试账号。
- 真实测试结束后，QQ 插件已停用、隔离 Profile 配置恢复 `connect:false`；测试 NapCat Desktop、BootMain 和 QQ 进程已停止。原 SnowLuma Bot 配置在测试前后哈希一致。
- NapCat 数据根独立，但 QQ 客户端媒体缓存仍共用系统 `Documents/Tencent Files`；不把此环境描述为客户端级完全隔离。私聊正文、消息 ID、空间 tid、Token、Cookie 和头像原件只保留在忽略的本地 QA 目录，不进入 Git 或安装包。

## 实际结果

| 场景 | 证据级别与结果 |
| --- | --- |
| 连续交互与 Owner | 隔离官方 DSH 模型实际调用 QQ 工具及原生 `pwsh`、`read`，完成本机只读任务；可信 Owner 私聊可见，普通 Scene 的可见性和执行期授权有回归。原 M1 多阶段发送、等待续接、撤权及硬重启见既有隔离 Desktop 报告。 |
| 真实入站 | NapCat `get_login_info` 成功；收到指定私聊的真实文字、图片和 `record`；`get_msg`/`get_record` 结构与插件读取路径核对。 |
| QQ 原生转写 | `fetch_ptt_text` 对真实语音首次暂时失败，随后返回非空文本。隔离 DSH 模型经 `qq_transcribe_message_record_native` 获得转写及正确原消息、发送者和私聊 Scene；硬重启后关联仍在。失败路径不编造转写。 |
| 真实外发 | 隔离 DSH 模型向授权私聊发送文字、图片、MP3 语音，插件返回 `delivered` 与消息 ID；NapCat `get_msg` 读回对应 `text`、`image`、`record` 段。没有向群发送。 |
| 账号资料 | 模型工具修改测试号签名和头像成功；签名读回，头像经平台外部接口读回测试图。两者已恢复原内容。头像经 QQ 平台重编码，恢复后视觉一致但字节哈希不同。 |
| QQ 空间 | `qq_qzone` 用 `audience:self` 发布文字和图片说说，均返回 tid；两个测试 tid 随后通过 NapCat 删除。其他可见范围及互动动作未作真实平台验收。 |
| 重启持久性 | 隔离 DSH 硬重启后复用相同私聊和空间 `actionId`，返回 `repeated:true`；私聊历史中测试文字只有一条。 |
| 管理 Web Console | 最终包安装到隔离官方 DSH Desktop 后，经 Host HTTP 取得页面、脚本与 Scene API（均 200），匿名请求 401，CSP 生效且 transport 为 disabled。单元/集成测试覆盖 Owner admission、跨源拒绝、权限 revision 冲突、POST 标记与元数据投影。页面尚未在 Desktop 浏览器人工操作。 |

## 收尾质量修复与同 Host 联动

- QQ Connector 的全局执行 guard 曾将 Owner Preset 已开放的动态注册工具再次拒绝。新增失败回归后修复：只有当前绑定、仍处于 Owner Agent 模式的可信管理员私聊，才能调用 Host 中已注册的非 QQ 工具；`run_code`、未知工具、普通私聊和群聊仍拒绝。隔离官方 DSH 中，全新合成 Owner Session 实际调用 `life_intent_create` 成功；旧 Owner Scene 经管理 API 降为 Safe Chat 后，旧 Session 再调用 `web_fetch` 得到执行期拒绝。Owner 的 `web_fetch` 在撤权前也完成一次真实 Host 只读调用。该隔离 Host 未安装 GitHub 工具，因此不宣称 GitHub 实调。
- QQ 与 Memory 在同一隔离官方 DSH Host 中用合成群 A、群 B、私聊分别验收 runtime context。每个 Session 只获得本 Scene 的标记，无跨 Scene 内容。原始 Session ID、标记及记忆内容只留在忽略的私有 QA 目录。
- Life 1.0.0 在同一隔离 Host 使用独立数据库与唯一合成 Owner Session 允许名单。模型工具创建的 intent 带 `life-tool:session:` 授权来源；Life wake 状态为 `executed`，唤醒后的模型调用了 Life 读取与 QQ 当前 Scene 的只读工具，未调用 QQ 发送工具。Life 当前 wake 提示明确禁止外发，因此本次只读闭环不能当作自主 QQ 发言验收。
- 入站 `get_image` 现在限制平台响应体大小，并仅接受受控本地路径或 canonical、有界的内联 base64 图片；`get_file` 超限路径也有回归。内联图片分支为单元/模拟证据，未声称真实 NapCat 返回过该形态。
- QA 收尾后 QQ 和 Life Bundle 均停用，隔离 Profile 恢复 `connect:false` 且无 Life 配置行，QQ 合成状态恢复测试前备份；测试 NapCat 仍停止。生产 DSH、SnowLuma、QQ Bridge、Memory/Life 数据未修改。

## 代码门禁与安装产物

- `npm test`：256 通过、0 失败、4 跳过。跳过项主要为当前 Windows 符号链接/可选外部环境限制。
- `npm run build` 与 `git diff --check` 通过。
- `npm pack` 的脱敏产物为 `dist/amadeus-qq-0.1.0.tgz`，SHA-256：`B5B76FCB306116C9BBD21F7DE343F80F07A1AFFDC32AB4E6095C78191E30A102`。包内仅包含 README、patch、构建后的客户端、源代码、构建脚本与 package metadata，不含私有 QA 状态和真实凭据。同代码包已在隔离 DSH Desktop 安装并经硬重启加载；最终包仅更新 README 后重新安装为停用状态，QQ 连接保持关闭。

## 尚未验证及部署建议

- Memory 同 Host 隔离与 Life 只读 Wake→QQ→执行记录已通过合成 Scene 验收；State 没有稳定运行源码，仅验证可选降级。Life 自主 QQ 外发需要其 wake 授权规则扩展，当前不宣称已完成。
- GitHub 工具、附件上传、引用/@/回应/戳一戳、QQ 空间互动、Web Console 人工 GUI 操作和长时间真实平台稳定性未逐项实测；对应功能保留源码及单元/模拟证据，不宣称真实 QQ 全覆盖。现有真实 QQ 核心收发证据来自修复前同一候选的未改动路径。
- 生产准备应先备份独立 QQ 状态文件，逐项确认 bot/owner/Scene 白名单、NapCat Token、媒体根目录及权限上限，再以小范围私聊灰度。观察 unknown 投递并人工对账，不自动盲重试。回滚时停用 QQ Bundle、恢复上一安装包和隔离备份状态；不回滚或修改生产 QQ/Memory/Life 数据作为测试手段。
