import { deriveTokens, schemeOf, type Skin } from '../../shared/skin';

/** Writes every color token of a skin onto :root. */
export function applySkin(skin: Skin, root: HTMLElement = document.documentElement): void {
  const tokens = deriveTokens(skin);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  root.dataset.scheme = schemeOf(skin.bg);
  root.style.colorScheme = schemeOf(skin.bg);
}
