# amadeus-qq

通过独立无头 NapCat 接入 QQ，维护持续收发、工具操作、等待续接、媒体、路由、去重和回执。

**当前状态：M0 基线与契约演示。已有脱敏历史轨迹及事件形状校验器，无可安装生产插件，独立 NapCat 联调未完成。**

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P0。当前仓库为私有。

## 职责与边界

QQ 交互以现用 bridge 的黑盒体验为基准，允许修改或重写。仅一个有效发送实例；不注册退群动作，不修改或打包 NapCat。Life 不得推进 QQ 消息游标。

基于官方 DSH 运行，不另建主 Agent 推理循环。人格统一由项目基础能力定义。需要受保护动作时不可绕过可信身份、数据范围与外发权限；可选模块未安装或故障时仅降级受影响能力。

## 模块约定

独立安装、升级、卸载，独立版本、测试和发布。后续必须声明能力、必要/可选依赖、契约兼容版本、健康状态与故障降级。目前这些契约仍待核实和确定，不声称已有可用接口。

## 开发入口

- [HANDOFF.md](HANDOFF.md)：当前状态、下一步与未运行检查。
- [M0 基线与检查](docs/m0/BASELINE.md)
- [QQ ↔ Life 契约草案](docs/contracts/qq-life-v0.1.md)
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

需求与验收关注：R-01、R-02、R-03、R-04、R-05、R-13、R-15；重点验收 A-02—A-06、A-12、A-15。

下一步：定位并核实独立无头 NapCat，补齐完整黑盒实机场景，再决定 QQ 模块的复用/重构与 OneBot 适配路线。

## 发布与隐私

尚无可用安装命令。许可证尚待明确，不因主仓库选择 MIT 而自动继承授权。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
