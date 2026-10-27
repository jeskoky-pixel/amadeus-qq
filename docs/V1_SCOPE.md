# Amadeus QQ v1.0 收缩后任务清单

更新：2026-10-27。`1.0.0` 已完成限定功能、隔离 DSH Host、真实 NapCat/QQ 与四插件同 Profile 的验收；以下仍区分各项证据来源。

| 领域 | 状态 | 剩余边界 |
| --- | --- | --- |
| M1 连续交流、去重、权限 | 隔离 DSH 模型调用、重启去重和撤权通过；真实私聊收发及重启后相同 actionId 去重通过 | 大规模长时间运行、QQ 平台风控与跨网络故障未测 |
| Owner Agent | 可信 Owner 私聊中的 DSH 原生 `pwsh`、`read`、`web_fetch` 实际由模型调用；已注册 Life 工具可由 Owner 调用，撤权后旧 Session 在真实 Host 被拒 | 隔离 Host 未安装 GitHub 工具，不能声称已验证 GitHub 调用；实际可用性取决于 Host 工具注册 |
| 日常消息 | 真实收取文字、图片、语音；向指定测试私聊发送文字、图片、MP3 语音并通过 `get_msg` 读回 | 长时间顺序性、平台风控与跨网络故障未测 |
| 群聊发送与附件 | 在仅含 Owner 与测试 Bot 的授权群，真实隔离模型调用 @+face、回复、回应、戳一戳和群附件工具，均返回 delivered；`get_msg` 复核到 @、face、reply 段；群文件根目录确认一个上传文件 | 群内批量/并发、其他消息类型和长时间顺序性未测 |
| 群附件回执 | 最终包与隔离 Desktop 重启后，新群附件返回 delivered，平台恰有一个匹配文件，经 `get_group_file_url` 解析回执；NapCat 列表会轮换 `file_id`，代码以稳定元数据/计数核对，歧义保留 unknown | 旧的 unknown 上传未被重试，也未确认其平台事实；未知结果仍靠人工对账 |
| QQ 原生 ASR | 本机 NapCat `fetch_ptt_text` 实际返回文本；隔离 DSH 模型工具得到原消息、发送者及私聊 Scene 绑定的转写，重启后保留 | 第一次平台调用暂时失败，重试成功；不能保证所有语音都可转写 |
| 外部 TTS 交接 | 受控目录 MP3 经 QQ 插件发送真实 QQ 语音；无内建 TTS 依赖 | 未与具体第三方 TTS 插件联测 |
| 账号资料 | 测试号头像和签名真实修改、读回并恢复 | QQ 头像恢复后视觉一致，平台重编码导致字节哈希不同；其他资料字段不作为门槛 |
| QQ 空间 | `qq_qzone` 统一入口；真实测试号的仅自己可见文字/图片说说发布得到 tid，并调用平台删除 | 点赞、评论等已有 Provider 动作仅单元/模拟；其他可见范围未实测 |
| Memory | 同一隔离官方 DSH Host 中，使用合成标记和真实绑定的群/私聊 Session：精确查询命中私聊标记，未观察到跨 Scene 注入 | 初始宽泛私聊查询未召回该标记；不宣称通用检索完备，长期生产流量未验证 |
| Life | 同一隔离 Host 的只读联动通过；受控外发 opt-in 已独立验证：intent 持久化 `life-tool:session:` provenance，管理员对同一 allowlist Owner Session 与授权 QQ 私聊开启 `externalMessageSessionIds` 后 wake 执行，模型恰好一次 `qq_send_message`，QQ 返回 delivered，NapCat `get_msg` 与指定 Owner 好友历史确认私有文字；关闭 opt-in 后新 intent 的 wake 为零 QQ 发送 | 首次尝试因错误 provenance 检查未发送，Life 源码已改为读取持久 intent；opt-in 只改变提示指导，不是 Life 级硬闸门，QQ Scene 权限仍是权威；长期自治与任意 QQ 目标未验证 |
| State | 可选降级，QQ 无硬依赖 | State 1.0.0 已合并；四插件同 Host 联合验收另行记录 |
| 管理与交付 | 原生 Settings、Admin API 和 Web Console；最终包隔离 Desktop 的 HTTP 路由、匿名拒绝、CSP、禁连状态和真实浏览器中的 Scene 图节点点击/筛选/重置已验收；停用 Memory Bundle 时同一 UI 仍加载并显示授权 Scene 拓扑，确认无 Memory 运行时依赖；权限编辑器保留 | 窄屏由横向滚动/列表回退处理，未做移动端视觉回归；Memory 自身实体 UI 是独立 Mneme 视图，本轮隔离库为空，未绘制新的语义图数据；安装包与 PR 交付见最终报告 |

## 已移出 v1.0 门槛

消息转发与合并转发、独立历史同步、好友和入群申请审核、群文件管理、大量群设置、内建 TTS、独立 ASR 服务、内建视频/文件理解、QQ 空间全部底层接口重写、复杂跨平台自主规划和大型 Web 仪表盘。已有能力保留。

## 验收纪律

真实外发只对用户授权的测试私聊和仅含 Owner 与测试 Bot 的授权群执行；群发送/附件证据来自该群。账号资料与空间操作只在测试号进行并已恢复或清理。隔离 NapCat 的 QQ 客户端媒体缓存仍共用系统 `Documents/Tencent Files`，因此本轮不宣称 QQ 客户端级完全隔离。生产 DSH Profile、SnowLuma Bot、QQ Bridge、Memory 与 Life 数据不应直接用作迁移或破坏性测试。

当前 `npm test`：281 通过、0 失败、4 跳过；四个跳过项均因本机 Windows 无法创建符号链接。`npm run build` 与 `git diff --check` 通过；`1.0.0` 最终包已在全新隔离 Desktop 与另外三个插件共同安装、加载和停用恢复，详见[联合报告](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/verification/AMADEUS_V1_FOUR_PLUGIN_ACCEPTANCE.md)。

## 部署与回滚建议

先在独立 QQ 状态文件和 `connect:false` 下核对 bot/owner/Scene 白名单、NapCat Token、媒体根与权限上限，再对授权私聊/小群灰度；观察 unknown 投递并人工对账，不自动重发。回滚时停用 QQ Bundle、恢复上一安装包与隔离备份状态，不改动生产 QQ、Memory 或 Life 数据。Life 受控外发只在管理员 opt-in、授权 QQ Scene 与明确目标下使用；该 opt-in 改变提示指导，不是硬性禁止层，QQ 执行权限仍是权威。
