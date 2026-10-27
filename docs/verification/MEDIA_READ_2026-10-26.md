# 入站图片读取与诊断隔离验收（2026-10-26）

## 本轮交付

- 新增 `qq_read_message_image(messageId, index?)`。图片引用只能来自当前 DSH Session 绑定 Scene 的持久消息；模型不能传路径、URL 或 OneBot `file` handle。仅 Enhanced 起可见，OneBot 返回后、文件读取后及 Host 附件保存后均复核 `qq.media.read`。
- `get_image` 只使用本地文件结果。显式配置的绝对 `mediaRoot`、真实路径包含关系、常规文件、文件大小（5 MiB）和图片签名均须通过；拒绝 URL-only、越界、符号链接及无效字节。官方 Host `attachments.saveImage` 负责最终图片解析与附件归一化。工具输出只有固定文本和 image block。
- 增加 `amadeus-qq-media` 与 `amadeus-qq-media-search` 受限 preset。Scene 权限决定建 Session 时的 preset；权限变更取消旧 Session。普通 QQ 文本连接器在无附件服务时仍可运行。
- OneBot 入站处理失败、连接失败及 socket 错误改为固定代码、按类别每 60 秒至多一条的诊断；日志不包含事件正文、异常 message、路径、URL 或凭据。

## 自动化检查

`npm test`：122 项中 **121 通过、0 失败、1 跳过**。跳过项为本机 Windows 无权限创建符号链接；独立的坏图片、越界、URL-only、5 MiB 超限、跨 Scene、OneBot 及 Host 附件保存期间撤权、参数伪造、缺少附件服务时的文本降级和 preset 可见性测试均运行通过。`npm run build` 与 `git diff --check` 通过。

## 官方隔离 DSH Desktop 实测

官方 DSH Desktop 0.2.1-rc.3、`deepseek-official/deepseek-flash`，仅使用隔离 Profile、合成 QQ ID、本机模拟 OneBot 和代码内固定 1×1 PNG。最终源码对应 QA.45 安装包 SHA-256：`153AEB87F8917636084CB9AF34CD7509F29B372011D3BA6099C6197D5776E67E`。

1. 先用 QA.41 私有一次性探针确认 Host 的 `attachments.saveImage` 和工具 image block 可用。模型请求包含探针工具，真实调用结果是 text + `image/png`，模型识别图片。探针代码未进入仓库。
2. QA.43 的 enhanced 群 Scene 绑定持久 Session 和消息 `701`。模拟 `get_image` 返回 `mediaRoot` 内 PNG 文件及一个不可达 URL。真实模型请求包含 `qq_read_message_image`；调用参数只有 `messageId`、`index`；结果为固定文本 + 69 字节 `image/png` 附件，模型识别图片。工具结果没有本机路径、URL 或 base64。
3. 硬重启隔离 Desktop 后，同一 Session、同一消息再次成功读取该附件，确认持久消息与 Scene 绑定恢复。
4. 管理端把 Scene 改为 Safe Chat 后，原 Session 被退休；再次强制调用返回 `QQ_PERMISSION_DENIED: qq.media.read`，无 image block。新建 `amadeus-qq-search` Session 的真实请求头没有图片工具，也没有 Shell。
5. Codex 追加 Host 附件保存期间撤权的失败回归并修复，同时收紧 `mediaRoot` 字面路径包含检查。最终 QA.44 重新安装、硬重启后，真实模型再次成功调用同一图片工具并收到 text + image block。
6. 最终 QA.45 再补缺少附件服务时的文本降级修复；安装并硬重启后管理端正常加载，普通 QQ 连接器健康状态可读。该末次改动只涉及可选服务注入失败的处理，QA.44 已通过的图片成功路径没有改动。
7. 隔离 Profile 最终恢复 `connect:false`，模拟 OneBot 两个本机监听端口均关闭。QA.45 保留在隔离 Profile，未触碰生产 DSH、NapCat 或真实 QQ。

## 边界

本轮只证实本机模拟 OneBot 的入站单张 PNG 路径。独立无头 NapCat 的真实 `get_image` 返回形态、媒体目录部署方式、其他图片格式与尺寸、语音/视频/文件读取、媒体发送、真实 QQ 投递和跨场景 Memory 隐私仍未实测。若实际 NapCat 只返回 URL/base64 而没有受控本地文件，此能力会明确失败。符号链接拒绝有源码检查，但本机自动化用例因 Windows 创建权限限制而跳过。当前仍是 Draft PR 的隔离候选，不能部署日常 QQ。
