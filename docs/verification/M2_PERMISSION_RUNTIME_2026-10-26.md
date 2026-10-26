# M2 权限运行路径阶段验收（2026-10-26）

本记录只覆盖 Scene 权限撤销和 Session 轮换的阶段性实现，不代表 Amadeus QQ v1.0 完成。

## 已修复

- Scene 权限版本绑定 DSH Session。旧 Session 的 QQ 工具在版本变化后立即拒绝。
- 权限管理入口 `QQCore.setScenePermissions` 先持久写入新权限，再请求取消旧活动；取消未获确认时不创建替代 Session。
- 轮换时使用全新 Session；旧 Session ID 在状态文件中持久留存，插件运行期 guard 继续识别它，QQ 工具仍因未绑定而被拒绝。
- Observe 或单项 `qq.send` deny 不唤醒模型。旧等待工具不再吞掉新 Session 的第一条消息。
- 创建 Session 或交付提示期间权限发生变化时，禁止继续提示；未交付消息保留待恢复。
- `qq_capability_execute` 沿用当前 Session 的 `qq.read` 和权限版本校验。

## 自动化验证

- `npm test`：75 pass、0 fail（隔离临时状态文件和模拟 OneBot）。
- 回归覆盖旧 Session 拒绝、取消失败关闭、重启后的旧 Session 索引、等待槽撤销、创建与提示期间的权限变化。

## 尚未验收

- 本次改动尚未重新安装到隔离 DSH Desktop 并验证真实 Session 取消 API。真实 QQ 未连接。
- 五级模式目前只接入权限决策和部分 QQ 运行路径；受限 preset 仍固定为 QQ 工具集合。Owner Agent、GUI、媒体、QQ 空间及 Memory/State/Life 联动仍需开发。
- DSH 取消是协作式的；已经提交到 OneBot 的外部请求无法被撤回。发送账本仍按回执状态处理未知结果。
- `setScenePermissions` 尚未暴露给原生 GUI；后续管理入口必须验证可信 owner 身份。
