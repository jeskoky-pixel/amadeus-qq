# Amadeus QQ v1.2.0 安装与升级

当前为内部发行候选。可从本仓库 PR 的 CI artifact 获取预构建 `fg-lab-amadeus-qq-1.2.0.tgz`；公开 npm、GitHub Release 与外部市场收录尚未执行。隔离测试使用官方 DSH Desktop `0.2.1-rc.3` 附带的 DSH 运行时；Desktop 图形安装仍待验收。普通用户不需要 Node、源码构建或 Codex。

## 首次安装

1. 在 DSH Desktop 打开目标 Profile 的插件管理器，选择安装本地预构建包；正式发布后也可选择 `@fg-lab/amadeus-qq@1.2.0` 的 npm 源或固定版本 GitHub Release。
2. 选择 `fg-lab-amadeus-qq-1.2.0.tgz`，确认已安装插件列表显示 `@fg-lab/amadeus-qq@1.2.0`，并打开其设置页。
3. 在设置中选择 Workspace、填写 Bot/Owner 与 NapCat，添加授权 Scene；未配置或未启用时不会连接或外发。
4. 按宿主提示重载或重启，回到设置页检查健康状态。安装失败时不要修改数据目录；保留错误信息与原安装包，然后恢复备份的 Profile。

## 升级

旧版升级前先导出 DSH Profile，停止插件写入，并对用户数据做一致性备份：`statePath` 指向的 Scene JSON、DSH Profile 中的 Bot/Owner/白名单及 DSH Session 日志。使用同一 Profile 安装 v1.2.0 包，不更换 Workspace、插件 ID 和数据路径。重启后检查内容与关键关联；仅在确认新版本正常后清理旧安装包。详细迁移和回滚规则见 [升级政策](UPGRADE_POLICY.md) 与 [数据迁移](DATA_MIGRATION.md)。

## 禁用、卸载与恢复

禁用只停止功能，保留数据。卸载默认只移除代码；用户数据位于安装包之外。插件管理器对 Profile 中配置条目的保留行为取决于宿主，卸载前必须导出 Profile。重新安装同一版本并恢复原配置路径可重新读取数据。彻底删除数据是独立、明确的人工操作，不能由安装脚本自动执行。

## 发行边界

当前本地预构建包已通过隔离官方 `dsh plugin` 安装；尚未通过公开 Market 下载源，也未验证生产 QQ/NapCat 或个人 Profile。不要把内部候选包当作已公开发布版本。
