export function readDialogFocus() {
  if (!import.meta.env.DEV || import.meta.env.COCKPIT_CHAT_LAB !== true
    || new URLSearchParams(location.search).get('scene') !== 'dialog-focus') {
    throw new Error('Use the isolated dialog-focus scene.');
  }
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) throw new Error('No focused HTML element');
  const style = getComputedStyle(element);
  return {
    tag: element.tagName,
    label: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 100),
    focusVisible: element.matches(':focus-visible'),
    pointerMarker: element.hasAttribute('data-native-dialog-pointer-focus'),
    outline: style.outline,
    outlineStyle: style.outlineStyle,
    boxShadow: style.boxShadow,
    readingTarget: element.hasAttribute('data-dialog-focus'),
    withinModal: !!element.closest('dialog:modal'),
  };
}

// Drive with actual browser pointer/key input before each assertion. DOM .click()
// alone cannot establish the browser's input modality.
export function checkDialogFocus(expected: 'pointer' | 'keyboard' | 'input') {
  const state = readDialogFocus();
  const fail = (message: string) => { throw new Error(`${message}: ${JSON.stringify(state)}`); };
  if (expected === 'pointer') {
    if (state.outlineStyle !== 'none') fail('Pointer dialog focus retained an outline');
    if (state.readingTarget && state.boxShadow !== 'none') fail('Pointer reading target retained a marker');
  } else if (expected === 'keyboard') {
    if (state.pointerMarker) fail('Keyboard input must clear the pointer marker');
    if (!state.focusVisible || (state.outlineStyle === 'none' && state.boxShadow === 'none')) {
      fail('Keyboard dialog focus must stay visible');
    }
  } else if (state.pointerMarker || !['INPUT', 'TEXTAREA', 'SELECT'].includes(state.tag)) {
    fail('Editing controls must retain their native focus policy');
  }
  return state;
}
