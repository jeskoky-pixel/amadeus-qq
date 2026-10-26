# `get_msg` 响应归属验收（2026-10-26）

`qq.get_msg` 的请求已受绑定 Scene 的持久消息 ID 限制；此轮补上平台响应正文的归属核对。含正文的响应现在要求有效且匹配请求的 `message_id`，返回的消息类型、群 ID、发送者 ID 若存在也必须与绑定 Scene 和持久消息一致。无正文的 `{ok:boolean}` 探针兼容保留。仍保留原有原始大小限制、字段投影、CQ 清洗和请求后的权限复核。

Codex 先写失败回归；原核心官方 DeepSeek Flash Creator 会话仅修改 `src/capabilities.js`；Codex 独立检查 diff。`npm test` 为 126 项中 125 通过、0 失败、1 跳过；跳过项为本机 Windows 无权限创建符号链接。`npm run build` 和 `git diff --check` 通过。

QA.47 包通过官方 Plugin Manager 安装到隔离 DSH Desktop。真实 `deepseek-official/deepseek-flash` 模型在绑定的合成私聊 Session 中调用 `qq_capability_execute` 两次；本机模拟 OneBot 对 `messageId=50002` 返回同 ID、同发送者的合成正文，工具成功；对 `messageId=777036` 返回其他 ID 的合成正文，工具只返回 `QQ_CAPABILITY_SCOPE_MISMATCH`，该正文未进入模型。没有 QQ 发送调用。随后 Host 硬重启，隔离 Profile 已恢复 `connect:false`，transport 为 `disabled`，模拟 HTTP/WS 端口无监听。

OneBot 侧仍是本机模拟；真实 NapCat 的响应字段差异和真实 QQ 链路尚未验收。
