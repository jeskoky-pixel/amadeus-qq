# M5 可选生态联动验收（2026-10-27）

本轮为隔离验收：只读比对已安装的 Memory/Life 源码与本仓库真实 Host 接口，未启动 Desktop、未连接真实 QQ、未读取 Memory 数据或生产配置。仅新增 `tests/optional-ecosystem.test.mjs` 与本记录，未修改任何 `src`、preset 或其他测试。

## 结论

| 联动 | 状态 | 证据 |
| --- | --- | --- |
| QQ → Memory 可信 Scene | **已真实接入**（源码契约一致） | Memory `inject.js` 通过 `ctx.reflect.get("qq")` 调 `resolveTrustedSessionScene(sessionId)`；`scene.js#mintTrustedScene` 只接受 `{platform:'qq'|'test', kind:'group'|'private', id, verified:true}`，`admin` 仅由 private 推导；本仓 `core.js#trustedSceneForSession` 返回 `{platform:'qq', kind, id:'botId:peerId', verified:true, admin: private && ownerPrivateIds}`，`index.js` 以 `ctx.provide('qq', …)` 暴露。 |
| Memory preset 门禁 | **已修复，需防漂移** | Memory 现以 `QQ_PRESETS` 集合 + `isQQSession()` 判断，含 `amadeus-qq`、`-search`、`-media`、`-media-search`、`-owner`；可信 Scene 包装与 user-settings 抑制都走同一判定。若新增 QQ preset 而 Memory 未同步，测试即失败。 |
| QQ → Life | **仅 Session 级，未接 Scene** | Life `sessionScope(exec)` 只取 `exec.agent.session.id` 形成 `session:<id>`；`isDshSessionScope` 接受 DSH Session；wake 目标来自显式 `allowedSessionIds`；Life 不读 `qq` 服务、不解析 Scene。QQ Session 可作为 Life 目标 Session，但没有 Scene 身份。 |
| Life 缺失 | **可选降级** | 本仓 `src` 无 `amadeus-life` 引用，QQ 不依赖 Life；preset guard 对非 QQ 工具（含 Life 工具）一律拒绝；Life 缺失不影响 QQ 收发/权限/GUI。 |
| State | **未实现** | `plugins/amadeus-state` 仅有 `README.md`、`HANDOFF.md`、`.gitignore`，无 `src`；本轮无可验收接口。 |

## 曾存在的跨 Scene 风险

早前版本 Memory 用 `sessionAgentId(ctx) === "amadeus-qq"` 精确比较：Media/Owner 等 preset 会绕过可信 Scene 包装，且 user-settings（未标注受众的画像/规则）不会被抑制。当前 Memory 源码已改为 `QQ_PRESETS` 集合，风险关闭；本轮不修改 Memory。

**最小修复建议（若再次漂移）**：两处门禁共用一个谓词，例如 `preset === 'amadeus-qq' || preset.startsWith('amadeus-qq-')`，或从 QQ 包导出 preset 前缀供 Memory 引用；不要在两处各自维护字面量。

## 测试

`tests/optional-ecosystem.test.mjs`（4/4 通过）：

- QQ Host 提供 Memory `mintTrustedScene` 所需字段与 id 字符集；`admin` 只对私聊产生。
- 本仓 `preset.patch.yml` 的每个 QQ preset 都在 Memory `QQ_PRESETS` 中；两处门禁使用 `isQQSession`；无精确单值比较。
- Life `isDshSessionScope('session:…')` 为真、`qq:…` 为假；`sessionScope` 仅用 Session id；无 QQ 服务依赖。
- QQ `src` 不引用 Life/State 服务；guard 拒绝非 QQ 工具；State 无源码。

外部源码路径可用 `AMADEUS_MEMORY_SRC` / `AMADEUS_LIFE_SRC` 覆盖；缺失时对应测试跳过，不伪造通过。

## 边界

- 只验证源码契约与已随包的 preset 列表，**未**在真实 Host 中联合启动 QQ+Memory/Life，也未验证注入内容、Scene 过滤结果、wake 投递或撤权。
- Memory 的 `sceneIsolationEnabled`/`strictQQ` 仍由 Memory 配置决定；跨 Scene grant 还要求 Memory 的 `hostContract`，QQ 不提供该授权。
- Memory 源码位于忽略的私有开发目录，其修复未进入本仓；本仓测试依赖该路径，CI 无源码时跳过。
- Life 只保证 DSH Session 兼容，不保证 Scene 级隔离；State 未实现，不能计为联动完成。
