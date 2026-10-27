# Amadeus QQ 1.0.0

当前候选已完成隔离 DSH 与真实 NapCat/QQ 的集中验收，详见[最终验收记录](docs/verification/V1_REAL_NAPCAT_2026-10-27.md)。真实私聊文字、图片、语音收发，QQ 原生语音转写，Owner 原生工具，测试账号头像和签名，以及仅自己可见的文字/图片说说均有实机证据；另在仅含 Owner 与测试 Bot 的授权群验证了 @+face、回复、回应、戳一戳和群附件发送及 delivered 回执。最小 Web Console 已加入现有 Admin API，并在隔离 Desktop 的真实浏览器中加载、点击节点、筛选和重置；在停用 Memory Bundle 时也通过，Scene 图只使用 QQ 自身授权 Scene 元数据和已观察稳定 QQ ID，运行时不依赖 Memory。Life 受控外发 opt-in 已独立验证。原 PR #1 保持 Draft，不自动部署或合并。

本地 ASR 是可选兼容路径；v1.0 默认使用已在真实 NapCat 验证的 QQ 原生 `fetch_ptt_text`。详细功能状态和未完成项以[收缩版清单](docs/V1_SCOPE.md)为准。早期的[隔离 Desktop 验收](docs/verification/M2_M5_ISOLATED_DESKTOP_2026-10-27.md)保留作为历史证据。当前源码 `npm test` 为 281 通过、0 失败、4 项 Windows 符号链接能力跳过。

通过独立无头 NapCat 接入 QQ，维护持续收发、工具操作、等待续接、媒体、路由、去重和回执。

**当前状态：`@amadeus/qq@1.0.0` 版本候选，PR #1 仍为 Draft。**已有独立插件包、连续 Session、逐 Scene 权限、原生 Settings 和最小 Web Console。真实 NapCat/QQ 已完成限定测试私聊和授权群的核心联调；Memory 在同一隔离 DSH Host 的 Scene 隔离、Life 到 QQ 的受控私有外发也已通过。受控外发依赖管理员 `externalMessageSessionIds` opt-in 改变提示指导，不是 Life 级硬闸门；QQ Scene 执行权限仍是权威。State 1.0.0 为可选模块，四插件共同运行的验收仍在进行；长期自治、任意 QQ 目标、通用 Memory 检索和移动端视觉回归仍未验收，不应直接部署到日常 QQ。

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P0。当前仓库已于 2026-10-25 根据用户要求公开，便于网页端审阅。

## 职责与边界

QQ 交互以现用 bridge 的黑盒体验为基准，允许修改或重写。仅一个有效发送实例；不注册退群动作，不修改或打包 NapCat。Life 不得推进 QQ 消息游标。

基于官方 DSH 运行，不另建主 Agent 推理循环。人格统一由项目基础能力定义。需要受保护动作时不可绕过可信身份、数据范围与外发权限；可选模块未安装或故障时仅降级受影响能力。

## 模块约定

独立安装、升级、卸载，独立版本、测试和发布。当前包以 `enabled: false` 和 `connect: false` 启动；启用需要显式配置隔离状态路径、受限 Agent preset、允许的 bot/群/私聊 ID。Capability Registry 已开放受 Scene 权限约束的只读、社交和群管理动作；NapCat 完整动作名目录只是待核实清单，不代表这些动作可执行。

## 开发入口

- [HANDOFF.md](HANDOFF.md)：当前状态、下一步与未运行检查。
- [发行说明](docs/RELEASE_NOTES.md)与[兼容性](docs/COMPATIBILITY.md)
- [GUI 隔离验收](docs/verification/GUI_STAGE_2026-10-26.md)
- [M0 基线与检查](docs/m0/BASELINE.md)
- [QQ ↔ Life 契约草案](docs/contracts/qq-life-v0.1.md)
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

需求与验收关注：R-01、R-02、R-03、R-04、R-05、R-13、R-15；重点验收 A-02—A-06、A-12、A-15。

下一步：按[收缩版清单](docs/V1_SCOPE.md)核对长期自治、任意 QQ 目标、移动端视觉回归与通用 Memory 检索；生产部署前先做小范围灰度与回滚演练。Life 受控外发只能经管理员 opt-in 和授权 QQ Scene 测试，QQ 执行权限仍是权威，不能把提示指导当作硬闸门。

## 发布与隐私

开发包可用 `npm pack` 构建，并通过官方 DSH Plugin Manager 安装到隔离 Profile。许可证尚待明确，不因主仓库选择 MIT 而自动继承授权。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
