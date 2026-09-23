function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Classic role picker regression: ${message}`);
}

export function runRolePickerChecks() {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true
    && new URLSearchParams(location.search).get('scene') === 'resources', 'isolated resource fixture required');
  const cards = Array.from(document.querySelectorAll<HTMLLabelElement>('.role-option'))
    .filter(card => card.checkVisibility());
  check(cards.length, 'open a new-session or existing-session role picker');
  return cards.map(card => {
    const input = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const marker = card.querySelector<SVGElement>('.ui-choice-check')!;
    const content = card.querySelector<HTMLElement>('.ui-choice-content')!;
    const name = card.querySelector<HTMLElement>('.role-option-name')!;
    const description = card.querySelector<HTMLElement>('.role-option-description');
    const box = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const markerBox = marker.getBoundingClientRect();
    const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    check(Math.abs(name.getBoundingClientRect().left - left) < 1, 'name starts at normal card padding');
    if (description) check(Math.abs(description.getBoundingClientRect().left - left) < 1, 'description shares the name edge');
    check(Math.abs(markerBox.right - right) < 1 && markerBox.width === 18, 'full-sized check at right card padding');
    check(content.getBoundingClientRect().right <= markerBox.left, 'content does not overlap check');
    for (const text of Array.from(card.querySelectorAll('.role-option-name, .role-option-description, .module-label'))) {
      const rect = text.getBoundingClientRect();
      check(rect.left >= left - 1 && rect.right <= markerBox.left, 'long text and badges stay inside content');
      check(text.scrollWidth <= text.clientWidth + 1, 'text wraps without horizontal overflow');
    }
    check(card.scrollWidth <= card.clientWidth && box.height >= 44, 'card fits and retains touch target');
    check((getComputedStyle(marker).visibility === 'visible') === input.checked, 'check matches native selection');
    check(card.hasAttribute('data-selected') === input.checked, 'selected background state retained');
    check(input.labels?.[0] === card, 'native label activation retained');
    check(input.getAttribute('aria-labelledby')?.split(' ').every(id => document.getElementById(id)), 'accessible name references exist');
    if (description) check(input.getAttribute('aria-describedby') === description.id, 'accessible description retained');
    if (input.matches(':focus-visible')) {
      check(style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2, 'keyboard focus visible');
    }
    return { name: name.textContent, checked: input.checked, disabled: input.matches(':disabled'),
      leftInset: name.getBoundingClientRect().left - box.left, rightInset: box.right - markerBox.right,
      markerGap: markerBox.left - content.getBoundingClientRect().right, height: box.height };
  });
}
