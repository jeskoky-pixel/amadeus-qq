# 本机 NapCat 接口核查（2026-10-27）

本轮只读检查了本机已安装的 `C:\ProgramData\NapCatQQ Desktop\components\NapCatQQ\napcat.mjs` 和启动文件。该目录包含 NapCat 核心及可启动入口；进程与服务清单只发现 NapCatQQ Desktop 管理的进程，未确认独立无头实例正在运行。本轮没有调用真实 QQ API、读取聊天数据或修改生产配置。

安装包中的 `get_record` 接受 `file`/`file_id` 与必填 `out_format`；允许的格式为 `mp3`、`amr`、`wma`、`m4a`、`spx`、`ogg`、`wav`、`flac`。其处理逻辑先解析/下载媒体，再转换为目标文件，响应写入本地 `file` 路径、`url` 和该文件的 `base64`。这证明接口形状，不能证明当前账号的某条真实语音一定转换成功。

安装包的外部 FFmpeg 转换分支对普通输出设置单声道，却没有为 WAV 固定 16 kHz；原生 addon 的输出采样率也未由源码保证。因此 QQ 插件现在对结构完整的非 16 kHz PCM16 WAV 使用显式配置的本地 ffmpeg 转成 16 kHz 单声道 PCM16，再交给本地 ASR。合成 24 kHz WAV 的本机真实 ffmpeg 回归已通过；仍需隔离实例的真实返回样本验证。

`get_file`/`get_image` 共用文件解析逻辑，接受 `file`/`file_id`，返回本地 `file`、`url`、`file_size`、`file_name`；仅在 NapCat 相应配置启用时附带 `base64`。调用可能触发平台文件下载。QQ 插件只接受经 Scene 持久消息定位的文件 handle，且只读取配置的 `mediaRoot` 内文件或严格有界 inline 内容；URL-only 返回明确失败。

以上是**本机安装源码证据**，不是独立无头进程的实机响应或真实 QQ 验收。下一次功能里程碑验收需在隔离实例获取实际 `get_record`/`get_file` 响应形状、文件路径归属和媒体格式，再验证发送回执、重启及撤权。
