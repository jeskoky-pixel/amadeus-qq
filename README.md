# amadeus-qq

通过独立无头 NapCat 接入 QQ，维护持续收发、工具操作、等待续接、媒体、路由、去重和回执。

**当前状态：v1.0 隔离开发候选，PR #1 仍为 Draft。**已有独立 DSH 插件包、持续 Session 核心、模拟 OneBot 回放、受限 Agent preset、逐 Scene 权限管理接口和原生 Settings GUI。隔离 DSH Desktop 已验证 GUI 场景选择、权限保存、并发冲突及重启持久性；测试记录见 [GUI 隔离验收](docs/verification/GUI_STAGE_2026-10-26.md)。目前仅 `qq.read`、`qq.send` 有对应运行路径；GUI 中其余能力明确标为策略占位。独立无头 NapCat、真实 QQ、完整媒体与空间、生态联动和跨场景 Memory 隐私尚未完成真实验收，不可部署到日常 QQ。

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P0。当前仓库已于 2026-10-25 根据用户要求公开，便于网页端审阅。

## 职责与边界

QQ 交互以现用 bridge 的黑盒体验为基准，允许修改或重写。仅一个有效发送实例；不注册退群动作，不修改或打包 NapCat。Life 不得推进 QQ 消息游标。

基于官方 DSH 运行，不另建主 Agent 推理循环。人格统一由项目基础能力定义。需要受保护动作时不可绕过可信身份、数据范围与外发权限；可选模块未安装或故障时仅降级受影响能力。

## 模块约定

独立安装、升级、卸载，独立版本、测试和发布。当前包以 `enabled: false` 和 `connect: false` 启动；启用需要显式配置隔离状态路径、受限 Agent preset、允许的 bot/群/私聊 ID。Capability Registry 仅开放经本地验证的少量低风险只读动作；NapCat 完整动作名目录只是待核实清单。

## 开发入口

- [HANDOFF.md](HANDOFF.md)：当前状态、下一步与未运行检查。
- [GUI 隔离验收](docs/verification/GUI_STAGE_2026-10-26.md)
- [M0 基线与检查](docs/m0/BASELINE.md)
- [QQ ↔ Life 契约草案](docs/contracts/qq-life-v0.1.md)
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

需求与验收关注：R-01、R-02、R-03、R-04、R-05、R-13、R-15；重点验收 A-02—A-06、A-12、A-15。

下一步：在真实 DSH 中验证强制非 QQ 调用拒绝与可信 Scene/Memory 边界，补齐独立无头 NapCat 和 M2–M5 能力，再做获授权的实机验收。

## 发布与隐私

开发包可用 `npm pack` 构建，并通过官方 DSH Plugin Manager 安装到隔离 Profile。许可证尚待明确，不因主仓库选择 MIT 而自动继承授权。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
