# amadeus-qq 交接

## 当前检查点（2026-10-26，只读结果投影）

已开放的只读 OneBot 能力按字段投影，稳定身份结果核对受控目标。125 项测试中 124 通过、1 项因 Windows 符号链接权限跳过；构建通过。QA.46 在隔离官方 DSH Desktop 中通过真实模型目录调用，合成凭据与 URL 未进入工具结果；硬重启后恢复 `connect:false`，模拟服务已关闭。详见 `docs/verification/READ_RESULT_PROJECTION_2026-10-26.md`。PR #1 保持 Draft，独立无头 NapCat 与真实 QQ 尚未验证。

## 当前检查点（2026-10-26，入站图片读取）

最新代码增加 Enhanced Scene 的 `qq_read_message_image`、两种媒体受限 preset、受控本地 `get_image` 文件读取及固定限频传输诊断。Codex 新增失败回归，原有两个官方 DeepSeek Flash 持久 Creator 会话分别实现媒体模块和 preset/Host 接线，Codex 独立审查。`npm test` 为 121 通过、0 失败、1 跳过；`npm run build` 通过。QA.43 在隔离官方 DSH Desktop 上经真实模型工具调用、image block、硬重启持久性与撤权拒绝测试；QA.44 再次通过真实模型图片调用；最终 QA.45 通过安装和重启加载。Safe Chat 请求头不含图片工具或 Shell。详见 `docs/verification/MEDIA_READ_2026-10-26.md`。隔离 Profile 已恢复 `connect:false`，本机模拟 OneBot 已停止。独立无头 NapCat、真实 QQ 和其他媒体形态仍未验证，PR 保持 Draft，不可部署。

## 上一检查点（2026-10-26，Owner 目录与媒体边界）

分支 `codex/m0-baseline` 和原 Draft PR #1 继续承载 v1.0 开发。原生 Settings GUI 的既有操作已在隔离 DSH Desktop 验收；本轮新增草稿切换保护已完成未保存时重选、跨 Scene 点击和取消后切换的真实 GUI 验收，保存中的切换拦截仍仅有客户端测试。`dsh.search` 的真实模型调用与撤权见 `docs/verification/SEARCH_BOUNDARY_2026-10-26.md`。Owner 私聊逐项授权的好友/群目录已完成真实模型工具调用、撤权及重启测试，见 `docs/verification/DIRECTORY_BOUNDARY_2026-10-26.md`。入站媒体与 `get_msg` 定位信息清洗也经真实模型工具调用，见 `docs/verification/MEDIA_BOUNDARY_2026-10-26.md`。`npm test` 当前 111/111。隔离 Profile 已恢复 `connect: false`，真实 QQ 未连接。通用 Owner Agent、媒体内容读取/发送、空间、Life/State 联动和独立 NapCat 实机兼容仍未完成，PR 不可合并部署。

以下为保留的早期 M1 与 M0 历史记录，相关测试数字和阻断状态以当前检查点为准。

## 历史 M1 检查点（2026-10-26）

当前分支仍为 `codex/m0-baseline`，PR #1 未合并。先看 `docs/verification/M1_CANDIDATE_2026-10-26.md` 和当前工作树，不要把下面的 M0 历史记录当作现状。`npm test` 当前 39/39；真实隔离 DSH 的旧候选已通过双发送、模型工具调用、非 QQ 工具拒绝和模拟事件等待续接。Codex 修复了等待消息重启重复投递的回归，但修复后的真实重启链路待复验。

受限 Agent preset 尚未通过官方 DSH 装载：同包自定义 guard 子项报 `never started`，无 guard 又会继承全局 Memory 工具。当前安装包未注册该 preset，源码拒绝以通用 `cordis`/`standard` 创建 QQ Session，真实 QQ 保持断开。原型、旧合成 Session 和模拟 OneBot 状态保留在本地忽略的 `private/qq-development/`，不在 tarball 中。不要向真实 QQ 发送或调整生产配置。

隔离 QA Profile 已恢复到不含 preset 原型的安装包，并在 Plugin Manager 中明确停用 QQ。后续验收先核对安装版本和连接仍关闭，再启用新的受限候选。

同一隔离 Profile 的旧 QQ `cordis` Session 还收到 Memory 自动注入的跨会话合成上下文；仅限制模型工具不足以隔离提示词。QQ + Memory 联合使用前，必须接通可信 Scene 与自动注入门禁，并验证非 QQ 记忆使用不回退。

更新日期：2026-10-25（Asia/Shanghai）。M0 部分完成。

## M0 最新入口

见 docs/m0/BASELINE.md 和 docs/contracts/qq-life-v0.1.md。已核实当前 DSH、bridge 与 SnowLuma，保存脱敏历史工具轨迹；独立无头 NapCat 未确认，未改动生产。

本仓库 tools/validate-envelope.mjs 为独立 DSH worker 经过同会话返工、Codex 审查验收的演示代码；不实现鉴权或消息队列。运行 node --test tests/validate-envelope.test.mjs tests/continuous-trace.test.mjs，本轮 16/16 通过。旧桥隔离等待回归另有 10/10；均不能代替新 NapCat 真实链路验收。

## 仓库

- 远端：https://github.com/jeskoky-pixel/amadeus-qq
- 默认分支：main
- 可见性：公开（2026-10-25 用户明确要求）
- 开发顺序：P0
- 本地位置：主项目目录下 plugins/amadeus-qq/，属于独立 Git 仓库。

## 已完成

仓库创建、独立本地克隆、README 与本交接文档初始化。文档随本仓库提交并同步到远端。提交版本通过 git log 或主项目交付消息核对。

## 计划职责

通过独立无头 NapCat 接入 QQ，维护持续收发、工具操作、等待续接、媒体、路由、去重和回执。

QQ 交互以现用 bridge 的黑盒体验为基准，允许修改或重写。仅一个有效发送实例；不注册退群动作，不修改或打包 NapCat。Life 不得推进 QQ 消息游标。

## 下一步

先核实现用 bridge、DSH 与 NapCat 版本并记录脱敏交互轨迹，再设计 OneBot 传输与连续对话的边界。

需求与验收关注：R-01、R-02、R-03、R-04、R-05、R-13、R-15；重点验收 A-02—A-06、A-12、A-15。

先阅读 README、主仓库 HANDOFF、多仓库约定和相关规格章节。正式开发由 Codex 编写有明确路径、契约、验收和预算的任务包；DSH 使用隔离开发 home 和工作区，不继承生产账号、记忆或发布凭据。

## 未运行与限制

- 已有事件形状演示校验器；未实施生产插件、构建、安装、升级、卸载或发布流程。
- DSH 与现用 bridge / SnowLuma 版本已核实，未验证独立 NapCat 和新插件的实际平台兼容性。
- 未运行本插件功能、契约、降级、权限或集成验收。
- 当前无契约兼容版本、release 或可安装依赖组合。
- 本仓库许可证未确定；任何第三方复用均须单独核查。

文档初始化不能计为产品验收通过。保留可选依赖边界，授权失败时不放行受影响动作；不把计划、超时或取消请求记作完成。

## 本地同步

在本仓库目录内查看 git status、git log 和 git remote -v；主项目不会代为跟踪本仓库文件。拉取与推送针对本仓库的 origin；主仓库的 plugins/ 被忽略，不使用 Git Submodule。

## 账号切换核查（2026-10-25）

- 当前分支 `codex/m0-baseline`；[PR #1](https://github.com/jeskoky-pixel/amadeus-qq/pull/1)（codex/m0-baseline，未合并）。状态：M0 部分完成，只有形状校验与脱敏测试资料，不是生产 QQ 插件。本轮只补交接文档，没有新功能。
- 当前文档提交请运行 `git log -1 --format=%H`；主项目 REPOSITORY_MAP 保存插件精确交付 SHA。
- 契约：QQ/Life 0.1-draft 草案；未实现运行时兼容。独立许可证待拥有者选择，不继承主仓库 MIT。
- 当前项目只推进 Life；本插件继续按上文职责保留，未经用户新指令不切换开发。QQ 遗留独立 NapCat 和真实链路验收仍待核实。
- 必读主项目 [接手入口](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/handoff/NEXT_CODEX_START.md)、[项目状态](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/handoff/CURRENT_STATE.md)、[架构](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/ARCHITECTURE.md)。
- 禁止改动生产 SnowLuma、QQ Bridge、生产 DSH 或登录/记忆数据；禁止 Computer Use、真实发送、擅自发布/merge；保留独立安装和可选依赖边界。文档保存不等于插件验收。
