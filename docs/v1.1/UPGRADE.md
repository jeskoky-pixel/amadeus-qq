# 从 1.0.0 升级到 1.1.0

1. 先备份 QQ 独立状态文件和 DSH Profile；在隔离 Profile 用 `npm pack` 生成的包升级并检查 Web Console。
2. 在“全局设置”选择现有 DSH Workspace。既有绝对 `sessionCwd` 仍用于旧配置兼容；选择 Workspace 后新建 Scene Session 归入该 Workspace。
3. 核对 Bot、唯一 Owner、NapCat 地址与 Scene 白名单。旧版已有的 Scene 权限及消息/投递状态沿用，不自动清除。
4. 逐 Scene 查看“实际生效”权限。1.1 普通预设不再默认允许群管理；如果确有需要，明确开启单项权限并确认 QQ 平台角色。
5. 检查账号资料和 QQ 空间页的独立授权。保存后按诊断页提示检查 Provider 和连接。
6. 重启 DSH Desktop，确认 Session 仍位于所选 Workspace，消息与投递账本连续。旧 Workspace 绑定切换时旧 Session 会撤权，新 Session 会建立。

回滚：停用 QQ 插件，恢复 1.0.0 安装包及升级前的独立 QQ 状态/Profile 备份；不要让 1.0 与 1.1 同时连接同一 Bot。当前 PR 未发布到插件市场，也未用于生产部署。
