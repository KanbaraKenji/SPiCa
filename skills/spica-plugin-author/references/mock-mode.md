# 模拟模式

在家里或外网连不上内部服务时，用户在 Spica 里打开模拟模式，插件就用样例数据回答。详见 Spica 仓库 `docs/plugins/authoring.md` 第 6 节。

- server 读环境变量 `SPICA_MOCK`，等于 `1` 时**所有**工具都只用 `mock/` 里的数据，不连任何真服务。
- 样例数据全部虚构：人名、公司、编号、地址都编，不要从真实系统里导出。
- 返回结果里标明是样例，例如加一个字段 `"note": "sample data (mock mode)"`，或文字开头写 `[sample data — mock mode]`。
- 模拟模式下的写操作只改内存，插件重启就恢复；不要写进真服务。
- `manifest.json` 写 `"mock": { "supported": true, "description": "模拟时会怎样" }`。
- 没开模拟、又连不上真服务时，返回 `[SERVICE_UNREACHABLE]`，文字里说「可以打开模拟模式试」，别让模型干等。
- `check.mjs` 和测试模板都在模拟模式下启动 server：模拟模式跑不通，就过不了检查。
