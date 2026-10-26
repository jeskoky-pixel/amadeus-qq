# Amadeus QQ v1.0 收缩后任务清单

更新：2026-10-27。基于 `codex/m0-baseline` 当前候选；原 PR #1 保持 Draft。这里区分源码、隔离 DSH Host 与真实 NapCat/QQ 的证据。

| 领域 | 状态 | 剩余边界 |
| --- | --- | --- |
| M1 连续交流、去重、权限 | 隔离 DSH 模型调用、重启去重和撤权通过；真实私聊收发及重启后相同 actionId 去重通过 | 大规模长时间运行、QQ 平台风控与跨网络故障未测 |
| Owner Agent | 可信 Owner 私聊中的 DSH 原生 `pwsh`、`read`、`web_fetch` 实际由模型调用；已注册 Life 工具可由 Owner 调用，撤权后旧 Session 在真实 Host 被拒 | 隔离 Host 未安装 GitHub 工具，不能声称已验证 GitHub 调用；实际可用性取决于 Host 工具注册 |
| 日常消息 | 真实收取文字、图片、语音；向指定测试私聊发送文字、图片、MP3 语音并通过 `get_msg` 读回 | 引用、@、回应、戳一戳、附件上传及长时间顺序性主要为单元/模拟 OneBot 证据 |
| QQ 原生 ASR | 本机 NapCat `fetch_ptt_text` 实际返回文本；隔离 DSH 模型工具得到原消息、发送者及私聊 Scene 绑定的转写，重启后保留 | 第一次平台调用暂时失败，重试成功；不能保证所有语音都可转写 |
| 外部 TTS 交接 | 受控目录 MP3 经 QQ 插件发送真实 QQ 语音；无内建 TTS 依赖 | 未与具体第三方 TTS 插件联测 |
| 账号资料 | 测试号头像和签名真实修改、读回并恢复 | QQ 头像恢复后视觉一致，平台重编码导致字节哈希不同；其他资料字段不作为门槛 |
| QQ 空间 | `qq_qzone` 统一入口；真实测试号的仅自己可见文字/图片说说发布得到 tid，并调用平台删除 | 点赞、评论等已有 Provider 动作仅单元/模拟；其他可见范围未实测 |
| Memory | 同一隔离官方 DSH Host 中，合成群 A、群 B、私聊各自只收到本 Scene 的 Memory runtime context；无跨 Scene 泄露 | 使用合成数据；长期生产流量尚未验证 |
| Life | 合成 Owner Session 实际调用 `life_intent_create`，取得工具授权 provenance；Life wake 执行后调用 QQ 当前 Scene 只读工具，执行记录为 `executed`；撤权后旧 Session 的原生工具调用被拒 | 本轮闭环不外发 QQ；Life wake 的现有规则禁止外发，未来自主发言需要 Life 侧明确授权设计 |
| State | 可选降级，QQ 无硬依赖 | State 尚无稳定运行源码，未联动 |
| 管理与交付 | 原生 Settings、Admin API 和最小 Web Console；最终包隔离 Desktop HTTP 路由、匿名拒绝、CSP 与禁连状态已验收；管理 API 实际撤销合成 Owner 权限 | Web Console 新页面尚未做人工 GUI 操作；安装包与 PR 交付见最终报告 |

## 已移出 v1.0 门槛

消息转发与合并转发、独立历史同步、好友和入群申请审核、群文件管理、大量群设置、内建 TTS、独立 ASR 服务、内建视频/文件理解、QQ 空间全部底层接口重写、复杂跨平台自主规划和大型 Web 仪表盘。已有能力保留。

## 验收纪律

真实外发只对用户授权的测试私聊执行；未向群聊发送。账号资料与空间操作只在测试号进行并已恢复或清理。隔离 NapCat 的 QQ 客户端媒体缓存仍共用系统 `Documents/Tencent Files`，因此本轮不宣称 QQ 客户端级完全隔离。生产 DSH Profile、SnowLuma Bot、QQ Bridge、Memory 与 Life 数据不应直接用作迁移或破坏性测试。
