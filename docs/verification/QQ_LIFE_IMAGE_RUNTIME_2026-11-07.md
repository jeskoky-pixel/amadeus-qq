# QQ Life 与图片运行时核对记录

日期：2026-11-07

## 修复内容

QQ 配置新增 `permissions.lifeReadPrivateIds`。它只向列出的私聊 Scene 授予 `amadeus.life.read`，不会授予 Owner 工具、Shell、QZone 或其他写能力。Scene 级显式 `deny` 仍然优先。

本机正式工作区将私聊 `1622647109` 加入该白名单。群聊 `902393625` 没有继承这项权限。

## DSH 启动根因与恢复

安装同版本 QQ tarball 时，npm 重新解析了 DSH profile 的共享依赖，将 `@deepseek-ai/dsh-agent` 降为 `0.2.0-rc.2`。官方 `agent-loop 0.2.2-rc.1` 需要 `AgentModel` 导出，因此 Host 启动失败并报告：

`The requested module '@deepseek-ai/dsh-agent' does not provide an export named 'AgentModel'`

已按官方启动日志恢复 `@deepseek-ai` 运行时插件到 `0.2.2-rc.1`，并恢复 Cordis `4.1.0`。随后重启 DSH，`127.0.0.1:3081` 已重新监听，没有产生新的 Host 崩溃日志。

## Session 证据

Host 实际生成的新 Session：

`session-46fb75bf-ee8d-4fcc-82eb-d3f6a6f25e3f`

其持久 projection 的 `agentPreset` 为 `amadeus-qq-life-media`。这说明私聊的 Life 读取和图片读取预设已在真实 Host Session 创建阶段生效。QQ state 的 `safe-chat` 是 Scene 对话模式字段，不能单独用来推断预设工具面。

## 图片链路证据

- NapCat `get_image` 使用入站消息保存的 basename `565D42CED7DA9903A72A4E50388AF672.jpg` 返回 200。
- 文件位于配置的 QQ Provider cache 根目录下，当前路径校验通过。
- 安装包的 `readMessageImage` 定向测试通过，能够生成受 DSH attachment service 管理的 bounded image attachment。
- 图片读取仍只接受已保存 Scene 消息的 messageId 和 ordinal。模型不能自行提交文件路径。

这证明了 QQ → NapCat → Provider cache → Core attachment 的文件链路已经修复。当前没有新的、重启后的真实用户入站图片事件，因此没有把受控读取结果冒充成模型完成视觉理解。下一次真实图片消息会使用上述新 Session 验证模型返回内容。

## 测试

`node --test tests/permissions.test.mjs tests/media-read.test.mjs tests/host-boundary.test.mjs`

- 45 tests
- 44 passed
- 0 failed
- 1 Windows symlink capability skip

完整 QQ 测试仍为 316 tests、311 passed、0 failed、5 Windows skips。构建和 release package check 已通过。

