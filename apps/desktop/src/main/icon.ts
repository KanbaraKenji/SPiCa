// The window / taskbar icon: the flower in one flat color, white on a dark
// Windows taskbar and black on a light one, no tile behind it. Made at run time
// from the brand's PNG (its alpha is the shape), so the brand files stay as
// they are. Pure helpers here; Electron glue in main/index.ts.

export type IconInk = 'white' | 'black';

/**
 * Recolors a BGRA bitmap (Electron's toBitmap) to one color, keeping the
 * shape. Chromium bitmaps are premultiplied, so white is written as the
 * pixel's own alpha (fully opaque = 255) and black as 0.
 */
export function flatten(bitmap: Uint8Array, ink: IconInk): Uint8Array {
  const out = new Uint8Array(bitmap);
  for (let i = 0; i + 3 < out.length; i += 4) {
    const a = out[i + 3] ?? 0;
    const v = ink === 'white' ? a : 0;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
  }
  return out;
}

/** An .ico file that holds PNG images (Windows Vista and later read these). */
export function icoFromPngs(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const header = 6;
  const entry = 16;
  let offset = header + entry * images.length;
  const total = offset + images.reduce((n, i) => n + i.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  images.forEach((img, k) => {
    const at = header + entry * k;
    const side = img.size >= 256 ? 0 : img.size; // 0 means 256
    view.setUint8(at, side);
    view.setUint8(at + 1, side);
    view.setUint8(at + 2, 0); // palette colors
    view.setUint8(at + 3, 0); // reserved
    view.setUint16(at + 4, 1, true); // color planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, img.png.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });
  return out;
}

/** Dark taskbar: white flower; light taskbar: black flower. */
export function inkFor(darkTaskbar: boolean): IconInk {
  return darkTaskbar ? 'white' : 'black';
}

/** The sizes the brand draws the taskbar mask at (spica-taskbar-<n>.png): 100%–200% scaling of 16, 24, 32 and 48, plus 64 and 256. */
export const TASKBAR_FRAME_SIZES = [16, 20, 24, 28, 30, 32, 36, 40, 42, 48, 64, 256] as const;
