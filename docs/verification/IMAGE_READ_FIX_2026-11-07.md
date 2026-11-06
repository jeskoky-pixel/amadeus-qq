# QQ 图片读取修复（2026-11-07）

## 根因

生产 Profile 已声明 `mediaRoot`，但首次运行时目录没有被创建。旧实现还在调用 OneBot `get_image` 之前无条件解析该目录，因此 NapCat 返回安全的内联图片数据时也会提前失败。

## 修复

- QQ 插件启动时创建已配置的绝对 `mediaRoot`，避免新安装因目录缺失直接失败。
- `qq_read_message_image` 只有在 OneBot 返回本地 `file` 时才解析 `mediaRoot`；内联 base64 仍经过 canonical、大小和图片签名检查，不读取 URL、不访问任意路径。
- 本地文件继续要求位于 `mediaRoot` 内，保留真实路径包含检查、符号链接拒绝、5 MiB 上限和 Host 权限复核。

## 验证

- 定向图片与 Host 边界测试：26 通过、1 个 Windows 符号链接权限跳过、0 失败。
- 新增回归：`mediaRoot` 为空时，canonical 内联 PNG 可以被保存为 Host attachment。
- 现有生产 `mediaRoot`：`C:\Users\Jesko\.dsh\profiles\desktop\data\amadeus-qq\media`；修复部署前已创建该目录。
- 本轮没有伪造新的 TIM 入站；电脑操作组件未能启动。已有真实 QQ 状态仍保留之前的图片入站记录和失败回复证据。
