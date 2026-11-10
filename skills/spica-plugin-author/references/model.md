# 用 Spica 里配好的模型

插件要让模型帮忙写摘要、分类、改写时，不用自带 API key：直接借用户在 Spica 里配好的模型（这在 MCP 里叫「取样」，sampling）。花的钱记在用户的预算里，每个插件每天另有上限。

> **版本**：需要 Spica 0.1.0-rc.2 之后发布的版本，rc.2 及更早的版本没有这个功能。在旧版上，插件拿不到这个能力（见第三节怎么判断），要给用户一句提示，不要崩溃。

## 一、在清单里申请

```json
"permissions": {
  "model": { "reason": "给笔记写摘要", "max_usd_per_day": 0.2 }
}
```

- `reason`（必填）：一句话说明为什么要用模型，安装和启用时 Spica 会给用户看。第一次用时不再弹确认框。
- `max_usd_per_day`（可选，缺省 0.5）：这个插件每天最多花多少美元。用户可以在插件页把它调低，实际生效的是两者中较小的那个；用户调成 0 就是不让它用。用户改了上限，插件 server 会重启一次。
- 另有几条固定限制：每个插件同时最多 2 个请求、每分钟最多 30 个；用户自己的总预算也照样管着。
- 没写 `permissions.model` 的插件拿不到这个能力，发请求只会收到 -32601（方法不存在）。

## 二、怎么调

用官方 MCP SDK 时：

```js
const r = await server.createMessage({
  systemPrompt: '你给笔记写摘要，只回摘要本身。',
  messages: [{ role: 'user', content: { type: 'text', text: `用两三句话总结：\n\n${note}` } }],
  maxTokens: 300,
});
// r.content.text 是回答，r.model 是实际用的模型
```

不用 SDK、自己写 JSON-RPC 时：向 Spica 发一个 `sampling/createMessage` 请求（server 发给客户端），再等同一个 `id` 的回答。能跑的例子在 `plugins/example-notes/server/index.js` 的 `summarizeNote`。

- 只能传文字，不能带工具，也看不到用户的对话。模型只看到你的 `systemPrompt` 和 `messages`。
- `maxTokens` 超过应用里设的上限时，按应用的上限算。
- 留痕里只记花费、模型和插件名，不记文字。

## 三、先看拿没拿到

Spica 在 `initialize` 请求的 `params.capabilities` 里带上 `sampling`，才表示这个插件可以用模型。下面三种情况都没有它：清单没申请、用户把上限调成 0、Spica 版本太旧。用到模型的工具先看这一项，没有就返回一句提示，例如：

```
[MODEL_NOT_AVAILABLE] 这个插件现在不能用模型：在插件页看看它的模型上限是不是 0，或者升级 Spica。
```

`check.mjs` 在模拟模式下启动 server 时不提供这个能力，所以工具必须能处理「没有」的情况。模拟模式只管插件自己连的服务，打开模拟模式时模型照样能用。

## 四、选模型

| 想要 | 怎么写 | 结果 |
|---|---|---|
| 用户的默认模型 | 什么都不写 | — |
| 强一点的模型 | `modelPreferences: { intelligencePriority: 0.8 }`（0.7 及以上），或 `hints: [{ name: 'strong' }]` | 用户配的强模型；没配就用默认模型 |
| 点名某个模型 | `modelPreferences: { hints: [{ name: 'example-large-model' }] }` | 用户配了就用它；没配就用默认模型，结果里带 `_meta.spica.fallback: true`，`model` 字段是实际用的那个 |
| 必须是这个模型 | 再加 `_meta: { spica: { requireModel: true } }` | 没配就拒绝，`data.code` 是 `model_not_configured`，插件提示用户去 设置 › 模型 配 |

模型名用通用的写法，不要写公司内部的代号。

## 五、被拒绝时

拒绝一律是 JSON-RPC 错误 `-32000`，`error.data.code` 说明原因。转成插件自己的错误码和一句人话：

| `data.code` | 意思 | 对用户说 |
|---|---|---|
| `invalid` | 请求写错了（没有 messages、带了工具、传了图片） | 这是插件的毛病，记日志、修代码 |
| `no_model` | 用户还没配任何模型 | 先在 设置 › 模型 里配一个 |
| `model_not_configured` | 点名的模型没配，而且写了 `requireModel` | 去配这个模型，或者去掉 `requireModel` |
| `budget` | 今天的上限或用户的总预算用完了 | 明天再试，或在插件页调高上限 |
| `rate_limited` | 一分钟内请求太多 | 过一会儿再试 |
| `failed` | 模型服务出错 | 稍后再试；详情在插件日志 |

## 六、页面不能直接用

插件页面的脚本里没有这个能力。页面要用模型，就调本插件 server 的一个工具，由 server 去请求模型。工具可以放在 `services/`，这样只给页面用、模型看不到。
