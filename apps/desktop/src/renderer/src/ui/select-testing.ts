// For tests: the app's drop-down (ui/Select.tsx) as a person uses it: open the list, read it, pick from it.
import { fireEvent } from '@testing-library/react';

const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role=menu] .context-item')];

/** The options' labels (the list opened and closed again). */
export function optionLabels(box: HTMLElement): string[] {
  fireEvent.click(box);
  const labels = items().map((b) => b.textContent ?? '');
  fireEvent.click(box);
  return labels;
}

/** The value now chosen. */
export const valueOf = (box: HTMLElement): string => box.dataset.value ?? '';

/** Opens the list and picks the option with this value. */
export function pickValue(box: HTMLElement, value: string): void {
  fireEvent.click(box);
  const it = items().find((b) => b.dataset.value === value);
  if (!it) throw new Error(`no option ${value} in ${box.getAttribute('aria-label')}`);
  fireEvent.click(it);
}

/** The group headings in the list, in order (the list opened and closed again). */
export function groupLabels(box: HTMLElement): string[] {
  fireEvent.click(box);
  const labels = [...document.querySelectorAll('[role=menu] .context-group')].map((g) => g.textContent ?? '');
  fireEvent.click(box);
  return labels;
}
