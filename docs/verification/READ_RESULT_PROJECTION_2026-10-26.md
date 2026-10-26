# 只读结果投影验收（2026-10-26）

此轮在原 Draft PR #1 的隔离开发分支上完成。代码将已开放的只读 OneBot 结果按能力投影为明确字段；好友、群、成员、登录信息中的额外字段不会原样送入模型。身份类结果要求稳定 ID，并核对与受控请求或绑定 Scene 的目标一致。`get_msg` 保留原有消息投影。

`npm test`：125 项，124 通过、0 失败、1 跳过；跳过项为本机 Windows 无权限创建符号链接。`npm run build` 与 `git diff --check` 通过。回归覆盖未知字段、路径、合成凭据、缺失 ID、目标 ID 错配和目录分页。

QA.46 用官方 DSH Desktop 隔离 Profile 安装当前包，以 `deepseek-official/deepseek-flash` 的真实模型会话调用 `qq_capability_execute` 两次。本机模拟 OneBot 返回 125 个合成好友和群，每行带额外 URL 或合成凭据字段。模型得到好友 offset 100/limit 20 的 20 条与群 offset 120/limit 20 的 5 条；工具结果保留合成名称、稳定 ID、总数及 `partial`，不含 `qa-friend-secret`、`qa-group-secret` 或 URL。该轮未调用 QQ 发送工具。Host 随后硬重启，隔离 Profile 恢复 `connect:false`，管理端 transport 为 `disabled`，模拟服务两个端口无监听。

这是**真实 DSH 模型与 Host**验收，QQ 侧仍是本机模拟 OneBot。真实无头 NapCat 返回形状、真实账号规模、延迟和真实 QQ 链路尚未验证；此轮不能作为生产部署结论。
