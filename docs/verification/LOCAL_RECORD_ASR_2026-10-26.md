# 本地语音转写与权限状态验收（2026-10-26）

新增 Enhanced Scene 的 `qq_transcribe_message_record(messageId,index?)`。工具只能从绑定 Scene 的持久消息取得 `record` handle，以固定参数调用 OneBot `get_record`；只读取已配置 `mediaRoot` 内的本地常规文件，限制 4 MiB、16 kHz 单声道 PCM16 WAV、最长 120 秒。ASR Provider ID 仅由插件配置选择，当前只接受 DSH 报告为 `host-local` 的 Provider。模型不能指定文件、URL 或 Provider；结果只返回受限长度的转写文本。缺少语音服务或未配置 Provider 时不注册工具，不影响文本和图片能力。权限变更后旧 Session 不会被语音工具自动恢复。

Owner Agent 与自主社交模式仍是部分实现。管理 API 对 `implemented:false` 的 Shell、QQ 空间能力现在始终显示 `effective:false`，运行授权也拒绝；原生 Settings 的模式名称与说明明确提示缺少的通用工具和 QQ 空间路径。模式策略仍可保存，具体可执行性以下方能力状态为准。

隔离 DSH Host 的真实 Settings 页面已用携带本机隔离会话 Cookie 的 headless Edge 只读检查：Amadeus QQ 设置可加载，两种模式的选项均显示“部分功能待实现”，Owner Agent 说明明确列出 Shell、文件、浏览器、GitHub 等缺口。测试只选择未保存的草稿，未修改 Scene 权限。

Codex 先写失败回归，原持久媒体与核心 DSH Creator 会话分别实现，Codex 独立审查并修正旧 Session 恢复问题。`npm test` 共 134 项：132 通过、0 失败、2 项因本机 Windows 无权限创建符号链接跳过；`npm run build` 与 `git diff --check` 通过。

QA.48 包通过官方 Plugin Manager 安装到隔离 DSH Desktop。隔离 Profile 临时启用官方语音 Bundle，SenseVoice 模型仅准备在 QA 专用目录；三个文件合计 241,357,257 字节，默认 DSH 语音数据目录未创建。本机模拟 OneBot 返回合成 `get_record` 文件，音频由本机离线 TTS 生成。真实 `deepseek-official/deepseek-flash` 模型请求头包含新工具，调用后官方 `sensevoice-local` 返回了转写文本（“Hello Aadadeus. This is a local synthetic voice test.”）；这是成功的本地 ASR 路径，识别文本与合成原句略有差异。将群 Scene 改为 Safe Chat 后，旧 Session 的工具请求头不再包含语音工具，强行调用返回 `QQ_PERMISSION_DENIED`，没有转写结果。

验收后隔离 Host 硬重启；QQ transport 为 `disabled`，本机模拟 HTTP/WS 端口无监听，语音 Bundle 已停用。QA.48 插件保留安装在隔离 Profile，语音模型文件保留在 QA 专用目录供后续测试。

**边界：**OneBot 侧仍为本机模拟。真实独立 NapCat 的 `get_record` 是否返回可访问的本地规范 WAV、不同媒体格式的转码、真实语音发送和远程 ASR 授权尚未验证。本轮不构成真实 QQ 部署验收。
