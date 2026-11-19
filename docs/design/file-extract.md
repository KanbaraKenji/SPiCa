# 文件读取设计（`@spica/extract`）

> 状态：首版完成（2026-11-09，b4e29f1）。PDF、Word、Excel、PowerPoint、CSV / 文本经内核真 read_file 跑通；DeepSeek 真模型跑 J2 通过。
> 需求来源：立项书「首版验收」J2、「Harness」工具结果规则（取数时间、不缓存）、「安装和运行都不需要管理员权限，不依赖系统预装组件」；内核接口见 agent-core.md 第 7 节。

## 1. 它做什么

模型调 `read_file` 读到非纯文本文件时，内核按扩展名把文件交给这里的提取器。提取器把文件变成**排好版的文本**（带页码、表名和行号列号、段落编号），同时给出**卡片元数据**（文件卡显示类型、页数、读了哪一段）。内核把文本原样交给模型，只在前面加取数时间和一行文件头，并发一个 `file.card` 事件给界面。

```
模型 ─read_file {path, pages?, sheet?, offset?, limit?}─► 内核 read_file
                                                         │ 按扩展名找提取器
                                                         ▼
                              @spica/extract  extractFile(path, req)
                                 │ 读文件（每次重读，不缓存）
                                 ├─ PDF  → unpdf（pdf.js）按页取文字层；字很少的页（扫描页）
                                 │         → PDFium（WebAssembly）画成图，交给内核发给模型
                                 ├─ Word / Excel / PPT → fflate 解压 + saxes 流式读 XML
                                 ├─ 旧版 .doc / .xls → cfb 读 OLE 容器，按微软公开的二进制格式取字
                                 └─ CSV / 文本 → 认编码（UTF-8 / GBK / UTF-16）
                                 ▼
                       { text: 排好版的正文, meta: FileCardMeta, truncated }
                                                         │
             模型看到：[fetched at …] + 文件头 + text ◄────┤
             界面收到：file.card { callId, file: meta } ◄─┘（在 tool.end 之前）
```

接线（桌面主进程，已由桌面外壳接好）：

```ts
import { createExtractors } from '@spica/extract';
new Runtime({ ..., extractors: createExtractors() });
```

## 2. 格式支持表

| 格式 | 扩展名 | 取到什么 | 分块单位（read_file 参数） | 目录（超限时列出） |
|---|---|---|---|---|
| PDF | .pdf | 每页文字层，按基线换行 | 页：`pages="3"`、`"2-5"`、`"1,4,7-9"` | 没显示的页号 + PDF 书签（含页码） |
| Word 97-2003 | .doc | 正文段落、表格（按段落属性里的「表格行结束」分行）、域只取结果；页眉页脚、脚注、批注、标题级别、列表层级不读；同一套块编号 | 块：`offset` / `limit` | 无（标题级别不读） |
| Word | .docx .docm | 段落、标题（`#` 级别）、列表（`-`）、表格（Markdown 表）；每块编号 `[12]` | 块：`offset` / `limit` | 没显示部分的标题和块号 |
| Excel | .xlsx .xlsm | 每张表：行号照 Excel、列用字母；共享字符串、日期、时间、百分比、布尔、公式的缓存值；隐藏表标「hidden」 | 表：`sheet`（表名或从 1 起的序号）；行：`offset` / `limit`（行号） | 所有表的名称和范围（如 `A1:F120`） |
| Excel 97-2003 | .xls | BIFF8 工作簿：共享字符串（跨 CONTINUE 记录）、数字 / RK / MULRK、日期格式、公式缓存值（数字、文字、布尔、错误）、布尔与错误值；排版和 .xlsx 同一套代码（`extractSheets`） | 同 Excel | 同 Excel |
| PowerPoint | .pptx .pptm | 每页文字、表格行、演讲者备注 | 页：`pages` | 没显示的页号 |
| CSV / TSV | .csv .tsv | 表格同 Excel（单表）；自动认分隔符（逗号 / 制表 / 分号 / 竖线）、引号与引号内换行 | 行：`offset` / `limit` | 总行数与范围 |
| 文本 | .txt .md .markdown .log | 带行号，和内核读纯文本的样子一致 | 行：`offset` / `limit` | 总行数 |

- 读表格时 `offset` 大于 1，会把第 1 行作为 `(header)` 一起给出，模型不用回头找表头。
- 编码：CSV 和文本自动认 UTF-8、带 BOM 的 UTF-8、带 BOM 的 UTF-16、GBK（按 GB18030 解，向下兼容 GBK）；都不是时按 UTF-8 解并标明「invalid bytes replaced」。
- `.xls` / `.doc` 先看文件头不看扩展名：OLE 文件按旧格式读；其实是 zip 的（改名的 .xlsx / .docx）交给新格式；是文本的（导出的 HTML、TSV）按文本或 CSV 读；`.doc` 其实是 RTF 时报「RTF，不在这里读」。Excel 5.0/95（BIFF5）、Word 6.0/95、加密文件都报明原因。
- 图片（.png .jpg .jpeg .gif .webp .bmp）不归提取器：内核 read_file 直接把图交给模型（`packages/core/src/tools/read-image.ts`），量尺寸、缩小、算 token 用附件那一套（`images.ts`）。8 位 PNG 和常见的 BMP（1/4/8/24/32 位、不压缩）内核自己解码、缩小，BMP 一律转成 PNG 发（模型都不收 BMP）；超限的 JPEG 由外壳用 Chromium 缩（`nativeImage`，它只认 PNG 和 JPEG）；超限的 GIF、WEBP 和少见的 BMP 由外壳交给 Windows 自带的解码器（`createThumbnailFromPath`：它只按正方形框等比缩，所以框取原图长边、不超过 1568；做的时候主进程会停 0.1–0.6 秒；竖的大 BMP 试过会失败，所以 BMP 不走这条），都经内核的 `Runtime.imageFitter` → 主进程 `images.fit`。在限内的 GIF、WEBP 原样发。当前模型标明不收图时，返回一句说明、不发图。
- 其余扩展名（.ts、.json 等）不归提取器，内核照旧按 UTF-8 文本读。

模型看到的样子（库存表第 3 行）：

```
[fetched at 2026-11-09T16:55:57.123+08:00]
库存表.xlsx (xlsx, 9078 bytes, modified …; read sheet 库存, rows 3-3, A3:F3)
Excel workbook, 4 sheets: 1 "库存" (A1:F7); 2 "进货记录" (A1:D3); 3 "空白页" (empty); 4 "说明" (A1:B3).
Rows are numbered as in Excel; columns are lettered. Cite cells as Sheet!C12.

=== sheet 1 "库存" — 7 rows with data, A1:F7 ===
row	A	B	C	D	E	F
(header) 1	品名	规格	数量	单价（元）	入库日期	占比
3	无线键盘	静音款	150	129	2026-10-15	30%
```

给模型的文字用英文（和内核其他工具一致），文件内容原样保留中文。

## 3. 分块规则

- 单次返回上限 **6 万字符**（`createExtractors({ maxChars })` 可改），同时不超过内核传来的上限（现为 20 万）。6 万字符约 1.5–3 万 token，读几个文件后上下文仍有余量。
- 按单位整块装：页、块、行装不下就停在上一个完整单位，不把一页切半；只有「第一个单位本身就超限」时才截断它，并写明截在第几个字符。
- 停下时末尾写一句怎么接着读，例如 `[Stopped because of the size limit. Not shown: pages 59-300. Call read_file again with pages="…" to read them.]`、`Continue with read_file sheet="月份1" offset=1296`，并按上表列出目录；`truncated` 置真。
- 不指定表时从第一张表起按顺序装，装满即停；没读到的表只从 `<dimension>` 取尺寸，不整表解析（6 万行的工作簿读一张表约 0.35 秒）。
- 防护：文件大于 200 MB 拒读；Office 包里 XML 解压后合计超过 512 MB 拒读（防压缩炸弹）；单元格超过 500 字截断。

## 4. 卡片元数据（`FileCardMeta`）

定义在 `@spica/protocol`，由内核提交；本包的类型是它的超集（多出的字段界面可以不用）。

| 字段 | 说明 | 卡片用途 |
|---|---|---|
| `path` / `name` | 绝对路径 / 文件名 | 标题、点开用系统程序打开 |
| `kind` | `pdf` `docx` `xlsx` `csv` `pptx` `text` | 图标 |
| `sizeBytes` | 字节数 | 副标题 |
| `modifiedAt` | 文件修改时间，本地时间带时区 | 副标题 |
| `extractedAt` | 这次提取的时间（每次重读，不缓存） | 悬停提示「取于…」 |
| `pageCount` / `slideCount` | PDF 页数 / PPT 页数 | 「共 N 页」 |
| `sheets` | `{name, rows, cols, range?}[]` | 「N 张表」，可展开表名 |
| `read` | 读了哪一段：`pages`、`sheet`、`rows`、`range`（如 `A3:F3`）；本包另有 `blocks`（Word 块号） | 「读了第 2 页」「库存 A3:F3」 |
| `truncated` | 这次没读完 | 「只读了一部分」 |
| `noTextLayer` | 扫描版 PDF，所有页都没有文字层 | 「扫描件，未识别文字」 |
| `encoding` | CSV / 文本认出的编码 | 悬停提示 |
| `blockCount` | Word 段落 + 表格数（本包扩展） | 可不用 |

## 5. 出错与边界

- 损坏、不是该格式、加密（PDF 有密码）、超大：抛 `ExtractError`，消息写给模型看（例如 `Not a readable Excel workbook (the file may be damaged, password protected, or in another format).`）；内核把它作为错误结果「Tool failed: …」交回模型，不中断运行。
- 空文件（0 字节）：正常结果「PDF file is empty (0 bytes).」，卡片照发。
- 扫描版 PDF：一页去掉空白后不到 40 个字（`SPARSE_TEXT_CHARS`）就算「字很少」，内核读时（`pageImages`）把这些页用 PDFium 画成图（长边 1568 px，按附件的上限），文字页照旧给文字。一次最多 10 张（`IMAGE_LIMITS.maxPerMessage`，和一条消息能附的图一样多），多出的页列出来并给出下一次的 `pages="…"`；`pages` 参数照常限定读哪几页，画图只在这些页里挑。灰度页存成灰度 PNG（约为 RGBA 的四分之一；量过一页带噪点的扫描页约 1.1–1.4 MB，压缩在线程池里做，约 0.1–0.2 秒），一页一页画（约 60 毫秒一页）、页与页之间让出事件循环。一次的页面图合计超过约 8.4 MB（`PAGE_PICTURE_BYTES`：一次请求能带 15 MB base64，留四分之一给对话里别的图）时，后面的页这次不发，写明下次的 `pages="…"`，免得同一批里前几页被请求上限挤掉而模型没看到。结果末尾写「N 张页面图随后发送，约 T token」，上下文卡的「图片」一行也会涨。当前模型不收图时（`pageImages: 0`）不画，写明「当前模型不收图」。不经内核读的（预览栏）不画，仍说「没有文字层」；卡片 `noTextLayer: true`。
- 每次请求最多带最新的 20 张图、base64 合计 15 MB（`REQUEST_IMAGE_LIMITS`）。同一步里几次调用并行返回的图合计超过它时，按调用顺序发到上限为止，剩下的不发，那次调用的结果末尾如实写「Not sent: …，你没看过，下一步再读」（`#appendToolResults`）。之后的请求里，更早、已经发过的图才换成一行「已在前面给过」（`keepRecentImages`）；最后一条回答之后的图若被挤掉，写的是「这次没发、你没看过」，不说给过。
- 页码或表名写错：错误结果里给出正确的范围或表名清单，模型能自己改。
- pdf.js 会尽量修复截断的 PDF：截掉一部分的文件可能读出前几页，也可能报错，两种都是干净结果。

## 6. 依赖与许可

只收 MIT / Apache / BSD / ISC 一类；运行时没有原生模块、没有系统组件、不需要管理员权限。

| 依赖 | 版本 | 许可 | 用在 | 说明 |
|---|---|---|---|---|
| unpdf | 2.1.0 | MIT（内含 pdf.js，Apache-2.0） | 运行时 | pdf.js 的无 worker、无 canvas 构建，零依赖；不用 pdfjs-dist 是因为它会顺带装可选的 @napi-rs/canvas 预编译二进制 |
| fflate | 0.8.3 | MIT | 运行时 | 解压 docx / xlsx / pptx；零依赖 |
| saxes | 6.0.0 | ISC | 运行时 | 流式读 XML；依赖 xmlchars（MIT） |
| @embedpdf/pdfium | 2.15.1 | MIT（包装）；PDFium 本身 BSD-3-Clause / Apache-2.0，wasm 里还编进了 zlib、libpng、OpenJPEG、AGG 等宽松许可的库 | 运行时 | 把扫描页画成图。纯 WebAssembly，零依赖；pdfium.wasm 4.6 MB（打包时作为单独文件复制到 out/main/chunks，`apps/desktop/src/backend/entry.ts` 告诉提取器在哪），JS 约 0.3 MB |
| cfb | 1.2.2 | Apache-2.0 | 运行时 | 读 .xls / .doc 的 OLE 容器；依赖 adler-32、crc-32（都是 Apache-2.0），合计约 0.4 MB（未压缩源码） |
| docx | 9.15.3 | MIT | 只在测试 | 生成 Word 样例 |
| write-excel-file | 4.1.1 | MIT | 只在测试 | 生成 Excel 样例；只依赖 fflate |
| pdf-lib | 1.17.1 | MIT | 只在测试 | 生成 PDF 样例（中文用不嵌入字形的 Identity-H 字体 + ToUnicode 表，不带字体文件） |

把 PDF 页画成图的几种做法（2026-11-18 比过）：pdf.js 自己画要 canvas，Node 里只有 @napi-rs/canvas（MIT，原生二进制，每个平台约 29–39 MB）；mupdf 的 wasm（14 MB）是 AGPL，不能进 Apache 仓库；只取 PDF 里嵌的图片（unpdf 的 extractImages，零新依赖）对多张拼成一页、带遮罩或旋转的扫描件会出错；@hyzyla/pdfium 也是 PDFium wasm，但 14 MB。所以用 @embedpdf/pdfium：真渲染、纯 wasm、体积最小。
旧版 .xls / .doc 不用 SheetJS（npm 上停在 0.18.5，有未修的告警，7.5 MB）、word-extractor（MIT，但带一份旧 saxes 5 和用不着的 yauzl，且表格单元格会被摊平）：BIFF8 和 Word 97 的取字部分照微软公开的格式（MS-XLS、MS-DOC）自己读，约 600 行，只借 cfb 读外层的 OLE 容器。
为什么不用 mammoth / exceljs / SheetJS：三种 Office 格式都是「zip + XML」，自己读只要两个小库，Word / Excel / PPT 共用一套读法；mammoth 只管 Word，exceljs 带上百个间接依赖，npm 上的 SheetJS 停在 0.18.5 且有未修的安全告警。PPT 样例手工拼包，因为能用的 PPT 写库带一个有高危告警的依赖。

## 7. 测试与冒烟

- `npm test`：`src/extract.test.ts`（每种格式正常、空文件、损坏文件、超大分块四类，外加指定页 / 表 / 行、GBK、UTF-16、扫描件、目录与续读提示）和 `src/read-file.test.ts`（经内核真 read_file：正文原样透传不再按行编号、参数传到提取器、file.card 事件、损坏文件变成工具错误）。共 34 条。样例在测试时现生成，内容全部虚构。
- `npm run smoke:extract -w @spica/extract`：生成样例文件夹（含 300 页 PDF、2200 段 Word、3×2 万行 Excel、200 页 PPT、5 万行 CSV），经 read_file 每个文件读一遍、大文件再续读一段，打印摘要、卡片和耗时。加 `-- <文件夹>` 读自己的文件夹。
- `npm run smoke:extract:agent -w @spica/extract`：DeepSeek 顶层 Agent 读报价单 PDF、会议纪要 Word、库存表 Excel 后回答三问。

| 日期 | 测试 | 冒烟 |
|---|---|---|
| 2026-11-09 | 34 条全过 | smoke:extract：13 个文件 18 次读取全过，最慢 6 万行 Excel 约 0.35 秒，300 页 PDF 约 0.25 秒；J2（deepseek-flash）：列目录 → 并行读 4 个文件 → 三问全对，回答里引用了「第 2 页」「单元格 C3」，3 次调用约 0.001 USD |

## 8. 留口

- **OCR**：扫描页现在画成图交给能看图的模型读；不能看图的模型读不了。以后要在本机识别文字，可以接在 `pdf-render.ts` 画出的图后面。
- **更多格式**：`FORMATS` 表里加一行（扩展名 + 处理函数）即可。可能要加的：旧版 .ppt（同样是 OLE 容器，「PowerPoint Document」流里按幻灯片取 TextCharsAtom / TextBytesAtom，约 120 行，不用新依赖）、.rtf、.html、.odt / .ods、.eml。
- **Word 页码**：docx 没有固定页，现在按块编号；要「第几页」需要排版引擎，不做。
- **合并单元格、批注、图片里的文字**：现在不读。

## 9. 故意没做

- 不缓存提取结果：立项书要求每次重查；大文件续读时会重新解析（一次 0.2–0.4 秒，可接受）。
- 不解析 Excel 公式本身，只用文件里存的计算结果；没有缓存值的公式单元格显示为空。
- 不识别 Big5、Shift-JIS 等其他编码（中文 Windows 常见的只有 GBK 和 UTF-8）。
