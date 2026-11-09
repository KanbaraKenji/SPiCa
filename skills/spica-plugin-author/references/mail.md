# 邮件来源

插件能列邮件、读邮件时，在 `manifest.json` 里声明，Spica 的邮件流水线就会在插件启用期间定时取新邮件、分到对应项目；停用时自动撤掉。详见 Spica 仓库 `docs/plugins/authoring.md` 第 6b 节，例子 `plugins/outlook-mail/manifest.json`。

```json
"mail": { "list_tool": "list_messages", "read_tool": "read_message" }
```

- 工具名写 server 里的原名，不带插件前缀。
- 插件有多个 MCP server 时加 `"server": "<id>"`。
- 列表结果默认这样读：`{ "messages": [ { "id", "from_name", "from_address", "subject", "received", "preview" } ] }`。字段名不同就用 `fields` 对应，例如 `"fields": { "list": "items", "subject": "title" }`。
- 列表调用默认带 `{ "unread_only": true, "limit": 50 }`，要改就写 `list_args`。
- 读邮件工具收 `{ "id": … }`，返回正文。正文不要写进日志。
- 两个工具都要在模拟模式下用虚构邮件回答。
