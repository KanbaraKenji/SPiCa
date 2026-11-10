// What kind of file it is, at a glance: the type on a coloured square on file
// cards, the file icon in that colour where there is only room for an icon.
// One place for every file shown (answers, attachments, details, preview).
import { Icon } from './Icon';

interface FileType {
  label: string;
  color: string;
}

const PDF: FileType = { label: 'PDF', color: '#d93f3f' };
const WORD: FileType = { label: 'DOC', color: '#2b6cd8' };
const EXCEL: FileType = { label: 'XLS', color: '#1e8e4f' };
const SLIDES: FileType = { label: 'PPT', color: '#d9622b' };
const IMAGE: FileType = { label: 'IMG', color: '#7c4ddb' };
const ARCHIVE: FileType = { label: 'ZIP', color: '#b7791f' };

const BY_EXT: Record<string, FileType> = {
  pdf: PDF,
  doc: WORD,
  docx: WORD,
  xls: EXCEL,
  xlsx: EXCEL,
  xlsm: EXCEL,
  csv: { label: 'CSV', color: '#1e8e4f' },
  ppt: SLIDES,
  pptx: SLIDES,
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  bmp: IMAGE,
  svg: IMAGE,
  zip: ARCHIVE,
  '7z': ARCHIVE,
  rar: ARCHIVE,
};

/** The file's type by its extension; undefined for plain text and anything unknown (shown as a plain file). */
export function fileType(name: string): FileType | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  return ext ? BY_EXT[ext] : undefined;
}

/** The square on a file card: the type on its colour, or the plain file icon. */
export function FileBadge({ name, className = 'file-card-icon' }: { name: string; className?: string }) {
  const t = fileType(name);
  if (!t) {
    return (
      <span className={className}>
        <Icon name="file" size={18} />
      </span>
    );
  }
  return (
    <span className={`${className} is-typed`} style={{ background: t.color }} aria-hidden>
      {t.label}
    </span>
  );
}

/** The file icon in the type's colour, where there is only room for an icon. */
export function FileGlyph({ name, size = 14 }: { name: string; size?: number }) {
  const t = fileType(name);
  return <Icon name="file" size={size} {...(t ? { style: { color: t.color } } : {})} />;
}
