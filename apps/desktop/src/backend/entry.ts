/// <reference types="electron-vite/node" />
// The agent core's own process (Electron utilityProcess). The core's standard
// entry, with the modules it would otherwise import by package name linked in
// at build time (the packaged app has no node_modules). Protocol and
// behaviour: packages/core/src/host/utility-entry.ts and agent-core.md 12b.
import { runUtilityEntry } from '@spica/core';
import * as extract from '@spica/extract';
import * as desktopHost from './desktop-host';
// PDFium for drawing scanned PDF pages (packages/extract/src/pdf-render.ts): the .wasm file is copied next to the
// bundle and found by its path here, as the packaged app has no node_modules.
import pdfiumWasm from '@embedpdf/pdfium/pdfium.wasm?asset';

extract.setPdfiumWasm(pdfiumWasm);
runUtilityEntry({ modules: { '@spica/extract': extract, '@spica/desktop-host': desktopHost } });
