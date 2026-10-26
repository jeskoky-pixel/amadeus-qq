# amadeus-qq 交接

## 最新检查点（2026-10-27，真实 NapCat/QQ 与 v1.0 收尾）

当前候选已通过 253 项测试、0 失败、4 跳过，构建与差异检查通过。隔离 DSH 模型实际调用 Owner 的 `pwsh`/`read`、QQ 原生 ASR、私聊发送、账号资料与 QQ 空间工具；真实 NapCat 私聊文字/图片/语音收发、`fetch_ptt_text`、头像/签名修改及恢复、仅自己可见说说发布和删除也已验证。重启后相同私聊与空间 `actionId` 去重有效。新增最小同源 Web Console，尚未完成实机 GUI 手动操作。当前隔离 QQ 插件停用、`connect:false`，测试 NapCat 已停止，原生产 SnowLuma 配置未改。完整证据与未验收边界见[最终验收记录](docs/verification/V1_REAL_NAPCAT_2026-10-27.md)，最新剩余清单见[收缩版 v1.0 范围](docs/V1_SCOPE.md)。PR #1 保持 Draft，不自动合并部署。以下为历史检查点。

## 最新检查点（2026-10-27，M2–M5 集中隔离验收）

原 Draft PR #1 的开发分支 codex/m0-baseline 已加入媒体发送/上传、可选 QZone Provider、账号资料、受控 Owner 工作区、群管理和相应权限/可靠性回归。Codex 独立 npm test 为 225 通过、0 失败、4 跳过；构建与差异检查通过。官方 DSH Desktop 隔离 Profile 安装 0.1.0-qa.final，真实模型工具调用、本机模拟 OneBot、平台拒绝、撤权、硬重启去重和 Owner 工具重启后读取通过。精确证据、包 hash、边界与回滚建议见 [集中隔离验收](docs/verification/M2_M5_ISOLATED_DESKTOP_2026-10-27.md)。Profile 已恢复 connect:false，模拟 OneBot 已停止；未连接真实 QQ 或生产 Profile。用户已指示暂缓新增 GUI 开发，保留已有 Settings 页面，可能后续改为 Web UI。不要把下方历史检查点当作当前代码状态。

## 当前 M3 开发检查点（2026-10-27，NapCat 安装源码核查与媒体读取）

只读核查了本机安装的 NapCat 核心 `napcat.mjs`：`get_record` 的 `out_format` 列表与本地 file/base64 返回路径已确认；外部 FFmpeg 分支没有保证 WAV 为 16 kHz，故本地 ASR 新增结构完整的非 16 kHz PCM16 WAV 转码。`get_file` 的 file/file_id 与 file/url/可选 base64 契约也已核实，但独立无头实例未确认正在运行，没有调用真实 QQ API。详情见 `docs/verification/LOCAL_NAPCAT_INTERFACE_2026-10-27.md`。

原核心和媒体 DSH Creator 会话合批实现群精华/荣誉只读投影、当前 Scene 持久消息的文件/视频读取；Codex 审查后为群读取补上 JSON 解析前 128 KiB 响应上限。文件/视频只允许受控本地路径或有界内联字节，模型不提供任意路径/URL。当前 `npm test` 为 161 通过、0 失败、3 跳过；构建与 diff check 通过。这些新增能力尚未做集中 DSH Desktop 安装、模型调用和重启验收；现有 M1/权限/GUI 验收仍有效。下一步主线是 M2–M5 的媒体发送、QQ 空间、Owner Agent 实际权限和生态联动，不再对每个小修改重复 Desktop 验收。PR #1 保持 Draft，不可部署。

## 当前开发检查点（2026-10-27，合批开发，Desktop 验收待完成）

继续复用三个隔离官方 DeepSeek Flash Creator 会话，由 Codex 先写失败回归、DSH 按核心/媒体/GUI 文件范围修复、Codex 复审。发送账本增加仅认证 Owner 可用的 unknown 投递人工对账：在途、已送达和非 unknown 状态不能标失败；Settings 必须输入同 Scene 的完整 actionId 才允许操作，且不自动重发。能力拒绝原因已有固定说明。语音读取增加显式 `ffmpegPath` 的本地 MP3→canonical WAV 路径；Codex 在本机真实 ffmpeg 上跑通合成 MP3 单元测试。`npm test` 为 145 通过、0 失败、2 项 Windows 符号链接跳过；构建与 `git diff --check` 通过。当前更改还未进行合批 DSH Desktop 安装、GUI 操作和重启验收；真实独立 NapCat 与 QQ 仍未连接。PR #1 保持 Draft，不可部署。后续应合并更多既定 v1.0 能力后集中做一次隔离 Desktop 验收，避免每个小修反复打包重启。

## 当前检查点（2026-10-26，QA.49 可靠性与内联语音）

原三个持久官方 DeepSeek Flash Creator 会话继续复用。Codex 的失败回归推动了 `unknown` 投递同内容新 `actionId` 的持久原子拦截、OneBot 有界内联 canonical WAV 读取，以及管理 API/GUI 错误归因；Codex 复审后补修未知 403 的保守只读规则。`npm test` 为 139 通过、0 失败、2 项 Windows 符号链接跳过。QA.49 官方隔离 DSH Desktop 通过真实模型工具调用、本机模拟 OneBot 内联合成 WAV、官方 SenseVoice 转写、撤权拒绝和重启后 Safe Chat 持久性；详见 `docs/verification/QA49_RELIABILITY_INLINE_AUDIO_GUI_2026-10-26.md`。隔离 Profile 已恢复 `connect:false`，语音 Bundle 停用，模拟端口关闭。真实 NapCat、媒体发送、QQ 空间、完整 Owner Agent 与生态联动仍未验收；PR #1 保持 Draft，不可部署。

## 当前检查点（2026-10-26，本地语音转写与能力状态）

新增受 Scene 约束的本地 record→SenseVoice 转写工具；Owner Agent / 自主社交未实现能力不再显示为运行时有效，GUI 明示部分功能待实现。134 项测试中 132 通过、2 项因 Windows 符号链接权限跳过。QA.48 在隔离官方 DSH Desktop 中以本机合成语音和模拟 OneBot 完成真实模型工具调用及本地 ASR；撤权后旧 Session 被拒绝。隔离 Host 已恢复 `connect:false`，语音 Bundle 停用。详见 `docs/verification/LOCAL_RECORD_ASR_2026-10-26.md`。真实 NapCat、真实 QQ、媒体发送和通用 Owner Agent 仍未验收，PR #1 保持 Draft。

## 当前检查点（2026-10-26，消息响应归属）

`qq.get_msg` 现在对平台返回正文核对请求消息 ID，并核对存在的 Scene/发送者字段。Codex 失败回归、原核心 DSH Creator 修复、Codex 复审与 QA.47 真实 DSH 模型工具调用已完成；错配正文未进入模型。126 项测试中 125 通过、1 项因 Windows 符号链接权限跳过；构建通过。隔离 Host 已恢复 `connect:false`。详见 `docs/verification/GET_MSG_SCOPE_2026-10-26.md`。PR #1 仍为 Draft。

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
