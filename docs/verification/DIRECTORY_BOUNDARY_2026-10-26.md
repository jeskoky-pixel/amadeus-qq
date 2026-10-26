# Owner 目录读取隔离验收（2026-10-26）

此轮验证仅使用官方 DSH Desktop 0.2.1-rc.3 的隔离 QA Profile、合成 QQ ID 和本机模拟 OneBot。未连接真实 QQ、生产 DSH Profile 或生产数据。PR #1 仍为 Draft。

## 代码与权限

- `qq.get_friend_list`、`qq.get_group_list` 只在已配置的 Owner 私聊 Scene 的 `owner-agent` 模式下，分别显式允许 `qq.friends.read`、`qq.groups.read` 才能执行。Owner 模式本身不继承目录权；普通 Scene 无法获权。
- 模型只可传入 `offset` 与 `limit`，OneBot 实际参数固定为 `{}`；分页限制为每页 1–100 条。请求前和响应后都核对当前 Session 绑定与授权。
- GUI 重选或切换 Scene 时，未保存的权限草稿与 revision 留在原 Scene，并显示保存或取消提示；保存中禁止切换。新目录权限有明确标签。

## 验证结果

`npm run build` 成功；新增回归在内的 `npm test` 为 105/105，`git diff --check` 通过。QA.39 安装包由当前源码复制打包，经官方 Plugin Manager 安装，SHA-256 为 `BBBF23E213629EC96C166F2B87401060C7F8473020E409A53EAD510AB34018EF`。

| 验证 | 结果 |
| --- | --- |
| 真实模型工具调用 | 官方 `deepseek-official/deepseek-flash` 在受控合成 Owner Session 中调用两次 `qq_capability_execute`，好友目录 offset 100/limit 20 与群目录 offset 120/limit 20 均成功；没有 QQ 发送调用。 |
| OneBot 参数及结果 | 本机模拟服务收到标准目录动作；单元回归核对参数固定 `{}`、分页、目标参数拒绝与普通 Scene 拒绝。 |
| 撤权 | 管理接口将两项权限改为 deny 后，旧 DSH Session 再调用目录能力返回 `QQ_UNAUTHORIZED`，没有目录内容进入模型。 |
| 重启持久性 | 隔离 Desktop 硬重启后，私聊 Scene revision 7、`safe-chat` 与两项 deny 保持；transport 已恢复 `disabled`。 |
| GUI 草稿 | 纯函数与生成的客户端包测试通过；本轮未对新增的切换拦截执行真实 GUI 点击验收，不能据此宣称该交互已在 Desktop 通过。既有 GUI 安装、选择、保存、冲突与重启证据见 `GUI_STAGE_2026-10-26.md`。 |

目录响应目前来自合成 OneBot；NapCat 返回字段差异、真实账号目录规模和延迟尚未验证。媒体与通用 Owner 工具仍需独立安全验收。
