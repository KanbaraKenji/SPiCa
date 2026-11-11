// 设置 › 外观 › 代码: the font size of code blocks, and the code colours for light skins and for dark ones, each
// picked from a list with a preview under it (a few lines with one changed, as a code block would show them).
import type { CSSProperties } from "react";
import {
  CODE_SIZES,
  codeThemeName,
  codeThemesFor,
  codeThemeVars,
  SKIN_CODE_THEME,
} from "../../../shared/code-themes";
import { DARK_SKIN, deriveTokens, LIGHT_SKIN } from "../../../shared/skin";
import { highlightCode } from "../chat/highlight";

const SAMPLE: { text: string; change?: "-" | "+" }[] = [
  { text: "function total(items) {" },
  { text: "  // 合计金额，保留两位小数" },
  { text: "  const sum = sumPrices(items);" },
  { text: "  return sum;", change: "-" },
  { text: "  return Math.round(sum * 100) / 100;", change: "+" },
  { text: "}" },
];

/**
 * The variables a preview needs: the built-in light or dark skin's own colours (跟随皮肤), with the theme's over
 * them; what a theme leaves to the skin (Claude 风格's background) shows as on that skin, whatever skin is on now.
 */
function previewVars(id: string, scheme: "light" | "dark"): CSSProperties {
  return {
    ...skinVars(scheme),
    ...(id === SKIN_CODE_THEME ? {} : codeThemeVars(id, scheme)),
  } as CSSProperties;
}

function skinVars(
  scheme: "light" | "dark",
): Record<string, string | undefined> {
  const t = deriveTokens(scheme === "light" ? LIGHT_SKIN : DARK_SKIN);
  return {
    "--code-bg": t["--spica-surface"],
    "--code-fg": t["--spica-ink"],
    "--spica-border": t["--spica-border"],
    "--hl-comment": t["--spica-muted"],
    "--hl-keyword": t["--spica-accent-text"],
    "--hl-type": t["--spica-accent-text"],
    "--hl-string": t["--spica-success"],
    "--hl-number": t["--spica-warning"],
    "--hl-variable": t["--spica-warning"],
    "--hl-attr": t["--spica-warning"],
    "--hl-title": t["--spica-ink"],
    "--hl-addition-bg": `color-mix(in srgb, ${t["--spica-success"]} 16%, transparent)`,
    "--hl-deletion-bg": t["--spica-danger-soft"],
  };
}

export function CodeThemePreview({
  id,
  scheme,
}: {
  id: string;
  scheme: "light" | "dark";
}) {
  return (
    <pre
      className="code-theme-preview"
      style={previewVars(id, scheme)}
      aria-hidden
    >
      {SAMPLE.map((line, i) => (
        <div
          key={i}
          className={
            line.change === "-"
              ? "preview-del"
              : line.change === "+"
                ? "preview-add"
                : undefined
          }
        >
          <span className="preview-sign">{line.change ?? " "}</span>
          {highlightCode("javascript", line.text) ?? line.text}
        </div>
      ))}
    </pre>
  );
}

export interface CodeThemesProps {
  value: { light: string; dark: string };
  onChange(next: { light: string; dark: string }): void;
  /** The font size of code blocks, px. */
  size: number;
  onSize(px: number): void;
}

export function CodeThemes({ value, onChange, size, onSize }: CodeThemesProps) {
  return (
    <>
      <label className="code-theme-pick code-size-pick">
        <span>字号</span>
        <select
          className="input"
          value={size}
          onChange={(e) => onSize(Number(e.target.value))}
          aria-label="代码字号"
        >
          {CODE_SIZES.map((px) => (
            <option key={px} value={px}>
              {px}px
            </option>
          ))}
        </select>
      </label>
      <div className="code-themes">
        {(["light", "dark"] as const).map((scheme) => (
          <div key={scheme} className="code-theme-row">
            <label className="code-theme-pick">
              <span>{scheme === "light" ? "浅色" : "深色"}</span>
              <select
                className="input"
                value={value[scheme]}
                onChange={(e) =>
                  onChange({ ...value, [scheme]: e.target.value })
                }
                aria-label={
                  scheme === "light" ? "浅色代码配色" : "深色代码配色"
                }
              >
                {codeThemesFor(scheme).map((t) => (
                  <option key={t.id} value={t.id}>
                    {codeThemeName(t, scheme)}
                  </option>
                ))}
              </select>
            </label>
            <CodeThemePreview id={value[scheme]} scheme={scheme} />
          </div>
        ))}
      </div>
    </>
  );
}
