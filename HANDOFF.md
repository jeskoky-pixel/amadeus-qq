# amadeus-qq 交接

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
