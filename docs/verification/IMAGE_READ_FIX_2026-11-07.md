# QQ 图片读取修复（2026-11-07）

## 根因

生产 Profile 已声明 `mediaRoot`，但 NapCat 的 `get_image` 返回的是其自己的 provider cache 路径，通常不在 QQ 插件私有目录内。旧实现把这个安全的、由绑定消息句柄返回的路径当成越界路径拒绝；首次运行时目录缺失也会导致同样的失败。

## 修复

- QQ 插件启动时创建已配置的绝对 `mediaRoot`，避免新安装因目录缺失直接失败。
- `qq_read_message_image` 仍优先使用配置的 `mediaRoot`。当 OneBot 返回 provider cache 文件时，只有在显式配置的 `providerCacheRoot` 之内才允许读取，并使用 canonical regular-file、完整路径符号链接拒绝、5 MiB 上限和图片签名检查。这个路径只来自绑定消息的 `get_image` 回读，不接受模型输入的路径。
- 内联 base64 不读取 URL。mediaRoot 缺失时仍要求 providerCacheRoot 有效，无法建立可信 provider 根时明确失败。Host 权限在平台调用前后各复核一次。

## 验证

- 定向图片与 Host 边界测试：27 通过、1 个 Windows 符号链接权限跳过、0 失败。
- 回归覆盖：声明的 provider cache 在 mediaRoot 外可读、未声明 provider 根被拒绝、provider 根外路径被拒绝、canonical 内联 PNG 可保存为 Host attachment。
- 现有生产 `mediaRoot`：`C:\Users\Jesko\.dsh\profiles\desktop\data\amadeus-qq\media`；修复部署前已创建该目录。
- 真实 TIM 入站复测仍待当前包重新安装并确认 NapCat provider 根。此前旧包得到 `QQ_MEDIA_ROOT_INVALID` 和 `QQ_MEDIA_PATH_OUTSIDE_ROOT`，这些结果没有被当作通过。

