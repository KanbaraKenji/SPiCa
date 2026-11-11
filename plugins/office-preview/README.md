# Office 原样预览（office-preview）

Spica 的官方插件：Word（.docx / .docm）和 Excel（.xlsx / .xlsm）在右侧栏按原样预览，不用 Spica 自带的「只有文字和表格」那一版。

- Word：docx-preview 画页面，字体（用电脑上有的）、颜色、字号、对齐、列表、表格边框、合并单元格、图片、页眉页脚。图表和复杂的浮动排版画不出来。
- Excel：ExcelJS 读格式，本插件自己画表格：填充色、字体颜色和样式、边框、对齐、合并单元格、列宽、行高、常见的数字格式（千分位、小数位、百分比、日期）、图片。图表、条件格式不显示；用了主题色的格子按默认色显示；超过 2000 行、200 列只显示前面那部分。有的 .xlsx 里的图片读不出（例如某些工具生成的），这时去掉图片照常显示表格，并说一句。

## 怎么用

装上、启用后，在 Spica 的 设置 里把 .docx / .xlsx 的预览选成「Word 原样预览」「Excel 原样预览」。没选的时候 Spica 用自带的预览。打不开的文件（坏了、太大、15 秒没画好），Spica 自动改用自带的预览。

## 开发

- 页面不在 Spica 里打开时（直接用浏览器打开 `ui/docx.html`），会出一个选文件的按钮，选一个文件看效果。
- `test/` 里是 `node:test` 写的测试，在插件文件夹里 `node --test` 就能跑（skill 的 `check.mjs` 也这样跑），不进插件包（`.spicaignore`）。页面在 Spica 里的样子（假的桥、jsdom）和完整自查，在仓库的 `packages/plugins/src/office-preview.test.mjs` 里测。
- 用到的库和来源、校验值见 `THIRD-PARTY.md`。
