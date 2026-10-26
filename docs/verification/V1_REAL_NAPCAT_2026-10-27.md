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
| 管理 Web Console | 同源静态页面复用现有 Admin API；单元/集成测试覆盖 Owner admission、跨源拒绝、CSP、权限 revision 冲突、POST 标记与元数据投影。页面尚未在 Desktop 浏览器人工操作。 |

## 代码门禁与安装产物

- `npm test`：253 通过、0 失败、4 跳过。跳过项主要为当前 Windows 符号链接/可选外部环境限制。
- `npm run build` 与 `git diff --check` 通过。
- `npm pack` 的脱敏产物为 `dist/amadeus-qq-0.1.0.tgz`，SHA-256：`D3D5F08C2D2ECC99E6ABDD1FA8C113D4CCD9BEDFF540BCCEA32F7CF710FD0BB4`。包内仅包含 README、patch、构建后的客户端、源代码、构建脚本与 package metadata，不含私有 QA 状态和真实凭据。

## 尚未验证及部署建议

- Memory 可信 Scene 源码契约及 preset 覆盖已有检查，但未在同一真实 Host 中进行 QQ+Memory 隐私数据验收。Life 只有允许名单 Session 级 Wake 契约，尚无 Wake→QQ→回执闭环；State 没有稳定运行源码。这些不能计为完整跨插件联动。
- 浏览器/GitHub 等 Owner 原生工具、附件上传、引用/@/回应/戳一戳、QQ 空间互动、Web Console 人工 GUI 操作和长时间真实平台稳定性未逐项实测；对应功能保留源码及单元/模拟证据，不宣称真实 QQ 全覆盖。
- 生产准备应先备份独立 QQ 状态文件，逐项确认 bot/owner/Scene 白名单、NapCat Token、媒体根目录及权限上限，再以小范围私聊灰度。观察 unknown 投递并人工对账，不自动盲重试。回滚时停用 QQ Bundle、恢复上一安装包和隔离备份状态；不回滚或修改生产 QQ/Memory/Life 数据作为测试手段。
