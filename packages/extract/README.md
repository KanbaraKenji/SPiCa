# @spica/extract

File extractors for Spica's `read_file` tool. They turn PDF, Word (.docx), Excel
(.xlsx / .xlsm), PowerPoint (.pptx), CSV / TSV and plain text / Markdown into text a
model can read, with structure (pages, sheets with row numbers and column letters,
numbered paragraphs and tables, slides) and the metadata the desktop file card shows
(`FileCardMeta` in `@spica/protocol`).

```ts
import { Runtime } from '@spica/core';
import { createExtractors } from '@spica/extract';

const rt = new Runtime({ providers, defaults, extractors: createExtractors() });
```

- Pure JavaScript at runtime: `unpdf` (pdf.js without worker or canvas), `fflate`, `saxes`.
- Large files are read in chunks: `pages` for PDF / slides, `sheet` + `offset` / `limit`
  (rows) for spreadsheets, `offset` / `limit` (blocks or lines) for Word and text. One read
  returns at most 60 000 characters and says how to continue.
- Scanned PDFs without a text layer are reported as such (`noTextLayer`); no OCR.
- CSV / text encodings: UTF-8, UTF-8 with BOM, UTF-16 with BOM, GBK.

Scripts:

- `npm test` (root) runs the tests; sample files are generated on the fly (fictional content).
- `npm run smoke:extract -w @spica/extract` reads a sample folder through the real `read_file`
  and prints a summary and timing per file (`-- <folder>` reads your own folder).
- `npm run smoke:extract:agent -w @spica/extract` lets a real model (DeepSeek from `.env.local`)
  read a PDF, a Word file and an Excel workbook and answer.

Design notes (Chinese): `docs/design/file-extract.md`.
