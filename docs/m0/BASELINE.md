# M0：当前 QQ 基线与证据

日期：2026-10-25。状态：基线已核查；NapCat 联调未完成，不可安装的生产插件。

## 实际安装与运行

- 官方 DSH Desktop / CLI：`0.2.1-rc.3`。CLI --version、安装包 package.json 与运行时清单相互印证。
- 现用 bridge：`https://github.com/Derpyu520/qq-bridge.git`，HEAD `a49877f4e58d04e47532d44b803360d0f001160d`，package version `0.2.1-r1`。
- 现用桥有 9 个 tracked 工作区修改标记、3 个 untracked 文件；其中两项 tracked 标记未产生 Git 规范化后的内容差异。源码快照不能仅由 HEAD 表示，主仓库 baseline.json 记录全部 12 个本地文件 SHA256。
- 本地修改涉及 bridge / MCP 封装、preset、人设、工具限制守卫和测试；不上传人设原文、私人配置或整个 dirty diff。
- 已安装 QQ preset bundle：`0.2.1-r3`；bridge 使用的 SnowLuma SDK / MCP 均为 `1.14.20`。
- bridge.lock 对应正在运行的 Node 进程；桌面 profile 引用了该桥的 MCP 封装；活动后端 Node 来自 SnowLuma 目录。
- 当前实际 QQ 后端：SnowLuma `2.1.1`（运行进程路径、package.json、release.json）。QQ 客户端目录版本 `9.9.36-53644`。
- 未核实独立无头 NapCat。找到 `NapCatQQ-Desktop-3.5.4-x64.msi` 历史安装器和 NapCatQQ Desktop 程序目录，只能证明下载/安装过桌面壳；该名字不能作为 NapCat 核心或无头服务版本证据。用户说明以前部署过，但不确定是否已删除。

## 连续交流记录

`continuous-trace.redacted.json` 来自本地真实工具调用日志的一个会话，保留 20 条调用/结果元数据，来源快照哈希和原始行号可供本机复查。包含三次发送以及多次等待、继续发送与收尾。

移除了正文、返回体、账号、原场景/会话 ID、令牌、URL、路径和绝对时间；仅保留统一别名与相对时间。原始日志和映射不提交。

**证据边界：**这是历史运行轨迹，不是本轮实机测试。日志 ok=true 只说明工具报告成功；未独立证明平台真实投递、等待中确有新消息到达、看图、引用、多群隔离或重连不双发。

## 本轮执行的隔离回归

对当前本机 bridge 快照执行原有 `scripts/test-reply-wait.mjs`，其 harness 使用临时文件、假的 DSH/QQ peer 与本地临时端口，不读生产 config、不向真实 QQ 发消息。命令为 `node --test <bridge>/scripts/test-reply-wait.mjs`，Node `22.23.2`，退出 0，10/10 通过。

覆盖首答静默窗口、等待期间消息补充不重复、读取水位、等待预算、权限变化、历史工具关闭与非法 purpose；该测试不是 NapCat 集成测试。原始 TAP 留在主项目被忽略的 `private/m0/`，公开摘要见主仓库 M0 报告。

## 本仓库可复跑检查

```text
node --test tests/validate-envelope.test.mjs tests/continuous-trace.test.mjs
```

事件校验器是 T-004 独立 DSH 开发执行器的演示产物。Codex 预先提供契约与测试，首稿因语法错误被拒，在同一 DSH 会话修正后 12/12 通过。轨迹检查另有 4 项；它们检查记录形状与顺序，不向平台重放消息。

## QQ ↔ Life

本仓库保存 `docs/contracts/qq-life-v0.1.md` 的一致副本。设计只提供旁路事件、观察者 checkpoint、获授权的唤醒排队与活动生命周期，不让 Life 推进 QQ 水位或直接发 QQ。它是 M0 草案，尚无运行时实现。

QQ bridge 是体验参考，可按许可和可靠性证据复用或重构；不冻结现有 5 分钟等待值、提示词与调用顺序。M1 必须用新 NapCat 适配器验证等价或更好的连续交互。
