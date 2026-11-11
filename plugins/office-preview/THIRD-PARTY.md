# 第三方文件

`ui/vendor/` 里的三个库文件，原样取自 npm 包（`npm pack` 下载、解开后只拷 `dist` 里的这一个文件和包里的许可证，没有改动、没有跑安装脚本）。核对：重新 `npm pack <包>@<版本>`，比对包的 integrity，再比对文件的 SHA-256。

| 文件 | 来源 | npm 包的 integrity | 文件 SHA-256 | 许可证 |
|---|---|---|---|---|
| `ui/vendor/docx-preview.min.js` | docx-preview 0.4.1，`dist/docx-preview.min.js` | sha512-Dv4g+LeE0swHpPvNC0lAT0YsR5Zq5pAxw7d3vHQ8EChBLgIrqqe9VPL5nVt2HBJap8bEZbXUI0TJob7kBeNU9w== | c4a133c65a112799e35b143c572dfff9e923a3bf39b5fd3b07a06aa0f8f530c2 | Apache-2.0（`ui/vendor/LICENSE-docx-preview.txt`） |
| `ui/vendor/jszip.min.js` | jszip 3.10.2，`dist/jszip.min.js` | sha512-3l+rb15IOWtUhU0H5MFqES/T6Kh7abYwjosBey/vD6hDt8zoEffkSC5Ws5SGtgVw3gBx2NEbhTeSW1+kWkpyTQ== | 7f839b2d4688b845c105ebf5d2f9803075f91ea0fe72bdaac176c3a04dd3d2c1 | MIT 或 GPL-3.0 二选一，**选用 MIT**（`ui/vendor/LICENSE-jszip.md`） |
| `ui/vendor/exceljs.bare.min.js` | exceljs 4.4.0，`dist/exceljs.bare.min.js`（不带给旧浏览器的补丁的那一版） | sha512-XctvKaEMaj1Ii9oDOqbW/6e1gXknSY4g/aLCDicOXqBE4M0nRWkUu0PTp++UPNzoFY12BNHMfs/VadKIS6llvg== | b039e32bfb7164dadd84a6973b30200dc07e1b58e1f21c546378fca6920a1f94 | MIT（`ui/vendor/LICENSE-exceljs.txt`） |

许可证文件的文字没有改动；仓库把换行统一成 LF，所以它们的字节和包里的不完全一样（库文件本身逐字节相同，上表的 SHA-256 就是提交进仓库的内容）。

docx-preview 用 jszip 解开 .docx（页面里先加载 `jszip.min.js`）；exceljs 自带解压，本插件另用 jszip 处理「带图片读不出」的 .xlsx（见 `ui/sheet.js`）。

## 已知问题

- exceljs 4.4.0 依赖的 uuid 8.x，npm audit 报过一条中危。按包里的代码，exceljs 只在两处调 uuid 的 `v4()`（不传参数）：写出条件格式时生成编号（`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`）。本插件只读文件、不写，走不到这两处；插件页也不能联网。
