# QQ ↔ Amadeus Memory 受信 Scene ACL 读契约 v1

状态：QQ 消费端与 Memory provider 已实现，并在隔离 DSH Desktop 中联测。此契约解决的是旧版/原版 Mneme 只注册 `memory_*` 工具、却没有严格 Scene ACL 时的跨群/私聊读取风险。

## 原则

- QQ **不按工具名、插件版本或 preset 配置**推断 Memory 的读隔离能力。
- 只有 Amadeus Memory 通过 Cordis 服务明确宣告 v1 受信 Scene ACL 读能力时，普通 QQ 预设才显示并放行 `memory_search`、`memory_list`、`memory_get`。
- 未安装、旧版、无声明、声明格式错误、声明不完整、声明调用抛错或声明被撤回时，QQ 一律拒绝执行并隐藏这三个工具。
- Owner 预设继续使用既有通用 host-tool 路径，行为不变。
- `scenes` 参数仍只是 Memory 服务端的缩小过滤器；QQ 不解析、不扩权。

## Cordis 4 服务名

服务名：`amadeus.memory`

已用 Cordis `4.0.4` 实测：

- `ctx.provide('amadeus.memory', service)` 支持带点号的服务名。
- `ctx.reflect.get('amadeus.memory')` 和 `ctx.get('amadeus.memory')` 均可发现该服务。
- 服务在父/子/兄弟插件上下文中可见；provider 卸载后变为 `undefined`。
- `internal/service` 事件会在 provide/withdraw 时携带 `('amadeus.memory', service | undefined)`，QQ preset guard 只用名称作为变更信号，并立即重新读取服务状态。

## Provider 形状

Memory 侧在 `apply()` 中提供，随插件 fiber 自动卸载：

```js
ctx.provide('amadeus.memory', {
  sceneAclRead() {
    if (cfg.sceneIsolationEnabled !== true || cfg.sceneStrictQQ !== true) return null
    const qq = ctx.reflect?.get?.('qq')
    if (typeof qq?.resolveTrustedSessionScene !== 'function') return null
    return {
      contract: 'amadeus-memory/trusted-scene-acl-read',
      version: 1,
      trustedSceneAcl: true,
      strictQQ: true,
      tools: ['memory_search', 'memory_list', 'memory_get']
    }
  }
})
```

约束：

- 在 QQ preset 与 connector 都能看到的 Cordis 作用域提供（通常是插件根/共享作用域）；不要把 `amadeus.memory` 放进 isolate，否则 QQ 会 fail closed。
- `sceneAclRead()` 同步返回声明或 `null`；不得返回 Promise。
- 只有严格 Scene 隔离、`sceneStrictQQ` 和可信 QQ Host 绑定实际可用时才返回声明。
- 配置热更新导致能力变化时，应撤回/重新提供该服务，或让 `sceneAclRead()` 立即返回新结果。
- 声明中的 `tools` 必须覆盖 QQ 允许的三个 reader；QQ 仍只会放行自己的三项，不因声明多出工具而扩大。

## QQ 消费与 fail-closed

- 普通预设（level 0–3）在声明缺失或无效时：
  - 执行守卫返回 `QQ Memory trusted Scene ACL read contract is unavailable`。
  - 已注册的 reader 通过 scoped deny 隐藏；可见性 allow mask 不包含它们。
- `tools/change` 与 `internal/service` 会重新读取声明，后注册的 reader 也会被覆盖。
- 每次执行都重新读取声明；启动后撤回声明会立即关闭执行路径。
- level 4 Owner 不依赖该声明，继续走既有 `qq.owner.tools` 通用 host-tool 路径。

## 隔离验收

- QQ `npm test`：**281 通过、4 跳过、0 失败**。真实 Cordis 4 回归覆盖启动、同步 `tools/change`、Memory 服务注册和撤销，未再出现启动时的事件递归。
- Memory 与 QQ 候选包在同一隔离 Desktop 启用并硬重启，Host 正常加载。QQ 候选包 SHA-256：`bb22942667e5d68e350a31e7c9d47ea883382b3fa040c0b5ac5ee55507705d78`。
- 三个 reader 在可信合成 QQ Session 的真实模型请求中可见，模型实际调用 `memory_search`。群 A 手动获准读取群 B 后见 A+B，群 B 只见 B，Owner 私聊见全部；撤销后群 A 立即只见 A。
- 模型 `memory_get` 直接读取未授权群 B 的 ID 返回 `memory not found`，`memory_list` 即使显式传入群 B Scene 也返回空列表。模型向量模式检索仍只返回已授权 Scene。
- 隔离验收没有向 QQ 群聊外发。生产环境未部署；长期聊天负载下的检索 P95 仍未测量。
