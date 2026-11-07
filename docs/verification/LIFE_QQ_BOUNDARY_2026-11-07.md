# QQ Life 工具边界（2026-11-07）

## 契约

`amadeus.life.read` 是 QQ Scene 的显式只读 grant。它不改变 `safe-chat` 默认权限，也不授予 QQ 外发、Life 管理、Owner 或文件系统能力。

有该 grant 的 Scene 创建带 Life 读取能力的受限 preset。没有该 grant 的 Scene 使用原有 preset，工具不会进入其可见工具集合。Life 读取工具在执行函数内再次验证真实 QQ Session、当前 Scene、Workspace、权限 revision 和显式 grant。

`life_shared_read` 调用 Core 提供的 `life.getSharedLifeView`，`life_health` 调用 Core 提供的 `life.getScopedHealth`。QQ 不读取 Life 数据库，也不创建第二套调度器。

## 版本

本次修改由 QQ 仓库提交 `97fdb39` 之后的工作树产生。最终提交和构建哈希在安装记录中补充。

## 当前证据

- 本地 QQ 回归测试通过。
- 未授权 Session 的执行 guard 继续拒绝 `amadeus.life.read`。
- 真实 TIM 在桥接版本重新安装后的工具 schema 和两次真实调用仍需复测。

