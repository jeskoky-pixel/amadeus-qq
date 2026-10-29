# Amadeus QQ 1.1.1 本地 AstrBot 交接验收

日期：2026-10-29。基线：`amadeus-qq/main` 的 `1bd1538e9eaae56329f4a713fa4a84d723c0c72b`。

## 行为

- DSH Owner Web Console 的“全局设置 → QQ 接管”通过现有 Config Editor 只改 `connect`，用修订号拒绝过期写入。QQ Scene 白名单、权限指纹和已绑定的 DSH Session 不随交接改变。
- 暂停先阻止新 QQ 外发和模型唤醒，再停止 OneBot WebSocket、取消重连与在途 HTTP 请求；等待本地请求完成记账后才保存配置。暂停时 Life 的 `qq.send` 能力查询返回拒绝。
- 收到但尚未提交给模型的旧唤醒在持久状态中标记为已处理，恢复后不会突然回复；已保存的消息和 Session 历史仍在。NapCat 已接收的在途操作无法撤回，未知结果保留为 `unknown`，不自动重试。
- 控制台与原生设置页用中文显示连接状态。暂停期间 AstrBot 的消息不会自动导入 Amadeus。

## 已运行

- `npm ci --ignore-scripts`：通过。
- `npm run build`：通过，生成 `lib/client.js`。
- `npm test`：303 项，298 通过、0 失败、5 跳过。跳过项为本机不允许建立符号链接的 4 项和测试工作树无法读取 Life 源码的 1 项，与本补丁无关。
- `npm pack --dry-run --json`：`@amadeus/qq@1.1.1`，44 个文件；包含 QQ Web Console、OneBot 运行代码和编译后的原生设置页，未包含私有配置文件。
- `git -c core.whitespace=cr-at-eol diff --check`：通过。

## 中文界面核对

QQ Web Console 默认 `zh-CN`，交接开关、状态和帮助文本均为中文。五个仓库的当前 `main` 中，Memory 注册了中文界面词条，State 与 Life 含 `zh` 字典，Persona 的默认语言为 `zh-CN` 并含中文词条；这四个插件无需为“支持中文 UI”另改核心代码。

## 尚未实机验证

用户正在重装本机 NapCatQQ Desktop，本轮没有连接真实 QQ 号或 AstrBot，也未在真实 DSH Desktop 上执行切换。必须在隔离 Profile 上实际检查：暂停后 AstrBot 接管、恢复前停用 AstrBot、重启后开关持久性、旧 DSH Session 是否继续使用同一绑定。自动化测试不替代这些结论。
