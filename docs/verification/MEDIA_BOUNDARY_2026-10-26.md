# 入站媒体定位信息隔离验收（2026-10-26）

本轮使用官方 DSH Desktop 0.2.1-rc.3、隔离 QA Profile、合成 QQ ID 与本机模拟 OneBot。未连接真实 QQ、生产 DSH Profile 或生产数据。此修复是输入和工具结果清洗，`qq.media.read` 仍未实现。

## 修复

- 入站 OneBot 段按类型投影：文本、at、reply、face 与媒体仅保留必要字段；未知段只保留类型。媒体 URL、本地路径、base64、额外字段不写入新消息状态，也不进入 DSH prompt。字符串格式消息中的完整 CQ 码被移除，保留码前后的普通文本。
- `qq.get_msg` 的平台响应使用字段白名单；`raw_message`、任意额外字段与媒体定位信息不会直接进入模型。数组和字符串格式的消息都保留清洗后的普通文本。
- 已有开发状态文件若包含旧版原始段，`core.read` 和待处理消息恢复写入 DSH prompt 前会再次清洗。旧文件本身不被静默重写；部署迁移需要单独备份与清理决策。

## 验证

`npm run build` 成功，`npm test` 为 110/110，`git diff --check` 通过。QA.40 安装包经官方 Plugin Manager 安装，SHA-256 为 `3C504988A9406DD69AF24D1FD3822EFE63FBAE35F228C32FFA6ABFFE77E93D5F`。

| 隔离 Desktop 验证 | 结果 |
| --- | --- |
| 合成私聊媒体消息 | 新状态记录保留 text/image/record/json 类型；媒体与未知段数据为空，合成 URL/路径标记未进入状态。 |
| 真实 DSH Session prompt | 官方 DeepSeek 模型所见 Session 事件包含正常文本，不含任何合成媒体定位标记；没有 QQ 发送工具调用。 |
| `qq.get_msg` 模型工具调用 | 模型实际调用 `qq_capability_execute`；工具成功，保留合成普通文本，原始 CQ 与 URL 标记未进入结果。 |
| 隔离恢复 | 最终将 Profile 恢复为 `connect: false` 并硬重启；QA.40 仍启用，transport 为 `disabled`，私聊权限 revision 7 与目录 deny 持久。 |

合成 OneBot 不能代替真实 NapCat 的消息字段兼容测试。媒体内容读取、下载和发送尚未实现；旧状态文件在磁盘上的既有原始字段需在正式部署前备份、评估并清理。
