# QQ 图片读取修复（2026-11-07）

## 根因

生产 Profile 已声明 `mediaRoot`，但 NapCat 的 `get_image` 返回的是其自己的 provider cache 路径，通常不在 QQ 插件私有目录内。旧实现把这个安全的、由绑定消息句柄返回的路径当成越界路径拒绝；首次运行时目录缺失也会导致同样的失败。

## 修复

- QQ 插件启动时创建已配置的绝对 `mediaRoot`，避免新安装因目录缺失直接失败。
- `qq_read_message_image` 仍优先使用配置的 `mediaRoot`；当 OneBot 返回 provider cache 文件时，使用同样的 canonical regular-file、符号链接拒绝、5 MiB 上限和图片签名检查读取该文件。这个路径只来自绑定消息的 `get_image` 回读，不接受模型输入的路径。
- 内联 base64 不读取 URL；mediaRoot 缺失时也只允许 provider 返回的绝对文件路径，Host 权限在平台调用前后各复核一次。

## 验证

- 定向图片与 Host 边界测试：27 通过、1 个 Windows 符号链接权限跳过、0 失败。
- 回归覆盖：provider cache 在 mediaRoot 外可读、mediaRoot 缺失时仍可读 provider cache、canonical 内联 PNG 可保存为 Host attachment。
- 现有生产 `mediaRoot`：`C:\Users\Jesko\.dsh\profiles\desktop\data\amadeus-qq\media`；修复部署前已创建该目录。
- 真实 TIM 入站复测已执行；在重启前的旧包上仍得到 `QQ_MEDIA_PATH_OUTSIDE_ROOT`，因此没有把旧结果当作通过。重装当前包并重启 DSH 后再复测，最终结果以运行记录为准。

