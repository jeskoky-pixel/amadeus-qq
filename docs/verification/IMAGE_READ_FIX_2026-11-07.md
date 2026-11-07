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
- 旧安装目录实际仍加载了未包含 provider-cache 回退的 QQ 包，因此真实图片请求报 `QQ_MEDIA_PATH_OUTSIDE_ROOT`。工作树修复已重新打包并安装到主 DSH。
- 当前包 SHA-256：`E383FE0DEAFA4445A6F6CF1092F03A826BE10F143643A288FA5836C5B152B3A8`；安装目录 `src/media.js` SHA-256：`279FBF61C9FB41A45A2ED597DBA00A78ED2A961645318E2C284F353757674F9C`，与工作树一致。
- 新 TIM 图片事件 `messageId=2009581422` 的原始 OneBot 句柄为 `565D42CED7DA9903A72A4E50388AF672.jpg`。NapCat `get_image(file=该句柄)` 返回可信 provider cache 路径 `...\\Pic\\2026-11\\Ori\\565d42ced7da9903a72a4e50388af672.jpg`，文件大小 `263144` 字节、JPEG 签名有效。使用当前包的真实 OneBot transport 和主 QQ state 回读，已成功生成 Host attachment `sha256:test-real`。
- 这条图片在旧包运行期间进入，随后 DSH 才重启并换成新 Session，因此没有形成新的模型回合。当前 DSH 已监听 `127.0.0.1:3081`，要取得“图片进入实际 Provider 请求并由模型回答”的证据，需要在重启后的连接窗口再发送一条新图片。

