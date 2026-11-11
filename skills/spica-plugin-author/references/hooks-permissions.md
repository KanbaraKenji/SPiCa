# 钩子和权限

详细参数：Spica 仓库 `docs/design/agent-core.md` 第 7 节（钩子）、`docs/plugins/authoring.md` 第 5 节。

## 钩子

`hooks/<名字>.js`（ESM），默认导出一个函数，参数是插件上下文，返回钩子对象：

```js
export default (ctx) => ({
  inject() {
    return [{ position: 'system:after', text: '…' }];
  },
});
```

| 类型 | 用来 |
|---|---|
| `inject` | 在系统提示、历史、用户输入的前后加文字（`system:before/after`、`history:before/after`、`input:before/after`） |
| `beforeRequest` | 发给模型前改工具表、参数 |
| `afterResponse` | 改模型的回答 |
| `beforeTool` | 拦截工具调用：放行、拒绝、要求确认、改参数 |
| `afterTool` | 改工具结果 |

- 用到哪几类就写进 `permissions.hooks`，没写的不生效。
- `ctx` 有 `name`、`version`、`dataDir`、`mock()`、`log()`。钩子在 Spica 进程里跑，别做耗时的事。
- 钩子抛错只记日志，这一轮当它没生效，不会让对话崩掉。
- 只收 `.js` / `.mjs`。

## 权限

- **不可逆**：`permissions.irreversible` 列出的工具，Agent 每次调用前 Spica 都问用户；页面调用时也先弹确认框。mcp/ 和 services/ 里的工具都适用。删除、发送、提交、付款、改外部系统的都要列。
- **工作文件夹**：`permissions.workspace` 写 `none` / `read` / `write`，告诉用户插件会不会碰项目文件夹。现在只展示，以后会拦项目文件夹外的路径，用户在对话里点名的文件夹除外。
- **写文件**：插件自己的数据只写 `SPICA_PLUGIN_DATA`。下载、导出的文件可以写进用户在对话里点名的文件夹：文件夹从工具参数传进来、不自己猜；只写那个文件夹和它下面，文件名里带 `..`、盘符的拒绝；结果里写出实际的完整路径；同名文件默认跳过，要覆盖就做成单独的工具并写进 `permissions.irreversible`。写这种文件夹不用为此声明 `workspace: write`。每个写出的文件在结果里附一项 `{ type: 'resource_link', uri: pathToFileURL(完整路径).href, name: 文件名 }`，Spica 会在对话里给它出文件卡，模型看到「文件：完整路径」。
- **网络**：`permissions.network` 列会访问的主机。现在只展示。
- **钩子**：`permissions.hooks` 见上。
- 原则：用不到就不写，写了就是告诉用户「我会做这件事」。
