# QA.49：发送去重、内联语音与管理错误归因（2026-10-26）

本轮继续原 Draft PR #1，未连接真实 QQ。Codex 先写失败回归，原三个持久官方 DeepSeek Flash Creator 会话分别处理核心、媒体和 GUI；Codex 独立审查并追加未知 403 错误码回归后交回 GUI 会话修正。

## 修改与验证

- 发送账本在持久状态变更内部拒绝“已有 `unknown` 投递、同 Scene 同内容、新 `actionId`”的第二次发送，返回 `QQ_DELIVERY_UNRESOLVED`。同一 `actionId` 的重复/冲突语义不变；不同内容、已明确成功或失败的内容不受该规则阻挡。跨重启与并发在途回归通过。未决投递不会被自动当作失败；相同内容若需再次发送，仍需人工核对平台事实。
- `get_record` 现在接受 OneBot 返回的原始 canonical base64 WAV，也保留原受控本地文件路径。模型仍只能给绑定 Scene 的消息 ID 与序号，不能传路径、URL 或 Provider。内联数据解码后至多 4 MiB，必须是 16 kHz 单声道 PCM16 WAV；OneBot 响应在 JSON 解析前以 6 MiB 封顶。`file` 与 `base64` 同时存在时以 `file` 为准，失败不回落内联；URL 不会抓取。MP3、SILK、转码和远程 ASR 尚未实现。
- 管理 API 返回固定错误码，GUI 分清认证失败、非法 Owner Agent 目标、Scene 出界和旧 Session 取消失败。取消失败提示权限可能已写入、需刷新确认，不会误报插件未启用；未知 401/403/503 仍按只读处理。

本机 `npm test`：**139 通过、0 失败、2 跳过**；跳过项均为 Windows 无权限创建符号链接。`npm run build` 与 `git diff --check` 通过。

## 官方隔离 DSH Desktop

QA.49 包通过官方 Plugin Manager 升级安装。硬重启后真实管理 API 加载合成 Scene，对群 Scene 的非法 Owner Agent 保存返回 `403` 与 `QQ_OWNER_AGENT_FORBIDDEN`；真实 Settings 页面可加载，Owner Agent 和自主社交仍显示部分功能待实现。

在本机模拟 OneBot 与官方 `sensevoice-local` Provider 下，使用 Enhanced 媒体 preset 的真实 DSH 模型请求头包含 `qq_transcribe_message_record`。模型只传 `messageId="701", index=0`，模拟端返回内联合成 WAV，工具成功输出转写文本。将同一群 Scene 改为 Safe Chat 后，旧 Session 的请求头不再包含该工具，强行调用得到 `QQ_PERMISSION_DENIED`。硬重启后管理 API 仍显示 Safe Chat、revision 6，且没有活动 Session。

首次隔离 Desktop 再启动时曾出现本机 Web 认证失败；使用同一隔离 DSH Home 的全新 Electron userData 后恢复，旧 userData 已保留于 QA 私有目录供排查。最终隔离 Profile 已恢复 `connect:false`、原 QA 状态文件，语音 Bundle 停用，本机模拟端口已关闭。默认 DSH 语音目录未创建；模型文件只保留在 QA 专用目录。生产 DSH、QQ、NapCat、Memory、Life 均未修改。

**边界：**此处 OneBot 是本机模拟，音频是合成 WAV；真实独立 NapCat 的 `get_record` 返回格式、MP3/SILK 兼容、媒体外发、真实 QQ 和跨插件端到端隐私均未验收。QA.49 仍不是生产可部署版本。
