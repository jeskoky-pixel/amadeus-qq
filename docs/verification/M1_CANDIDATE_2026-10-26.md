# M1 隔离候选验收（2026-10-26）

当前代码是开发候选，不是可连接日常 QQ 的版本。

## 同日补验：容量和受限 preset

- Codex 先提交两项失败回归，原 DSH Creator 修复旁听群消息滚动与发送账本满额。Codex 追加较早重要消息被较新已读水位淘汰的失败回归并返工；最终 `npm test` 为 63/63。普通旁听窗口可滚动，仍待 DSH 交付的消息保留；成功/失败动作进入有界归档，`unknown` 保留并在全为未决时明确拒绝新动作。归档之外的旧 actionId 不提供无限期防重保证。
- 包内 `@amadeus/qq/preset-guard` 子路径可被 Node 解析，但官方 DSH preset registry 报 `never started`。隔离原型改为让 preset 子插件挂载包主模块，并以 `presetGuard: true` 进入 guard 分支；隔离 DSH 重启后 registry 无 broken 状态。
- 官方 DSH Desktop 0.2.1-rc.3 隔离 Profile，QQ 组件 `connect: false`：新建 `amadeus-qq` Session 的真实 `request/header` 含 8 个 QQ 工具、0 个非 QQ 工具。该合成请求未出现 Memory 跨会话注入标记；单次未命中不能证明跨 Scene 隐私已通过。
- 隔离 Profile 停用 QQ 包后，旧 Session 的下一请求头含 0 个非 QQ 工具。隔离 DSH 重启后旧 Session 因 `Unknown agent preset: amadeus-qq` 拒绝恢复，未回退到通用 preset。测试过程中没有连接 NapCat 或真实 QQ。
- 强制调用非 QQ 工具的宿主拒绝证据、修复后等待工具的真实重启续接、可信 QQ Scene 到 Memory 的传播仍待验证。五级预设、逐 Scene 权限、Owner Agent、媒体、空间与 GUI 尚未交付；本节不将它们计为通过。

## 已验证

- 旧候选 `npm test`：39 pass、0 fail。覆盖场景隔离、持久 Session、重复输入、发送 unknown、不盲重试、权限撤销和等待续接；当前结果见同日补验。
- 真实官方 DSH Desktop 0.2.1-rc.3，独立 Profile，OpenCode Go 的 DeepSeek V4.1 Flash：模型在同一 turn 中依次调用 `qq_send_message`、`qq_connection_status`、第二次 `qq_send_message`；本地模拟 OneBot 返回两条独立送达回执。模型尝试 `pwsh` 时，QQ 宿主 guard 返回拒绝。
- 同一合成 Session 后续调用 `qq_wait_for_messages`，模拟 OneBot 新事件使工具返回 `arrived:true`，模型随后调用 `qq_send_message` 获得模拟回执。此前两次等待超时的记录不计作事件驱动续接成功。
- Codex 在上述真实验收后发现：旧包在等待工具交付消息后仍保留待提示标记，重启可能再次投递。新增失败回归后修复，自动化测试通过。真实模型轨迹使用修复前的隔离包，修复后的重启交付链路仍需复验。

## 未通过的安全门槛

QQ Session 必须使用独立受限 Agent preset。原 QA 使用通用 `cordis` preset 加运行时 guard；停用或卸载插件后该 Session 的边界不能保证。当前源码拒绝以 `cordis`、`standard` 创建持久 QQ Session。

随包受限 preset 原型在官方 Plugin Manager 中可注册，但其自定义 guard 子模块创建 Session 时报告 `never started`。仅保留基础人格的原型可创建 Session，却继承了 Memory 等全局工具，因此不符合隔离要求。该 preset 已从安装包声明中撤回，当前候选应保持断开真实平台。修复须以真实 DSH Session 的工具清单和拒绝执行证据验收，不能只靠配置文件或模拟测试。

同一隔离 Profile 中，旧 QQ `cordis` Session 还收到 Memory 自动注入的跨会话合成上下文。工具执行 guard 不会拦截提示词注入。QQ 与 Memory 联合部署前必须有可信 Scene 绑定和自动注入门禁，并验证普通非 QQ Memory Session 的原有行为。

## 仍待完成

独立无头 NapCat 的真实链路、媒体与社交能力、QQ 空间、Life/Memory/State 可信联动、原生 GUI、停启/升级/回滚及获授权真实 QQ 行为均未验收。模拟 OneBot 的回执不是平台实际投递证据。所有本机 Session、Cookie、模拟状态与原始日志只保留在忽略的 `private/` 目录。
