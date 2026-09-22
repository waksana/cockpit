import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installNativeDialogFocus } from './nativeDialogFocus';

const marker = 'data-native-dialog-pointer-focus';
class Element {
  attributes = new Set<string>();
  open = true;
  isConnected = true;
  isContentEditable = false;
  modal: Element | null = null;
  readonly tagName: string;
  constructor(tagName = 'BUTTON') { this.tagName = tagName; }
  setAttribute(name: string) { this.attributes.add(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  matches() { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName); }
  closest() { return this.modal?.open && this.modal.isConnected ? this.modal : null; }
}

test('native-dialog presentation policy is bounded and never moves focus', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Element });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'HTMLElement', original);
    else Reflect.deleteProperty(globalThis, 'HTMLElement');
  });
  const window = new EventTarget();
  const events = Object.assign(new EventTarget(), { activeElement: new Element('BODY'), defaultView: window });
  const dispose = installNativeDialogFocus(events as unknown as Document);
  t.after(dispose);
  const emit = (name: string, target: Element = events.activeElement) => {
    const event = new Event(name);
    Object.defineProperty(event, 'target', { value: target });
    events.dispatchEvent(event);
  };
  const focus = (target: Element) => {
    emit('focusout');
    events.activeElement = target;
    emit('focusin', target);
    assert.equal(events.activeElement, target, 'policy must not focus or blur anything');
  };
  const modal = new Element('DIALOG');
  const close = new Element();
  close.modal = modal;
  focus(close);
  assert.equal(close.attributes.has(marker), false, 'unknown/programmatic entry stays visible');
  emit('pointerdown');
  assert.ok(close.attributes.has(marker), 'same focused control need not emit focusin');
  emit('keydown');
  assert.equal(close.attributes.has(marker), false, 'keyboard restores current indication immediately');
  emit('pointerdown');
  window.dispatchEvent(new Event('blur'));
  assert.equal(close.attributes.has(marker), false, 'browser chrome can receive the next keyboard input');
  focus(close);
  assert.equal(close.attributes.has(marker), false, 'window return without a new pointer is not suppressed');

  emit('pointerdown');
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const input = new Element(tag);
    input.modal = modal;
    focus(input);
    assert.equal(input.attributes.has(marker), false, `${tag} keeps native indication`);
  }
  const editable = new Element('DIV');
  editable.isContentEditable = true;
  editable.modal = modal;
  focus(editable);
  assert.equal(editable.attributes.has(marker), false);
  focus(close);
  assert.ok(close.attributes.has(marker));

  for (const tag of ['BUTTON', 'A', 'DIV']) {
    modal.open = true;
    focus(close);
    modal.open = false;
    const trigger = new Element(tag);
    focus(trigger);
    assert.ok(trigger.attributes.has(marker), 'native return can target a control or reading ancestor');
    emit('close', modal);
    assert.ok(trigger.attributes.has(marker), 'queued close must not erase the returned pointer indication');
    emit('keydown');
    assert.equal(trigger.attributes.has(marker), false);
    emit('pointerdown');
  }
  const outside = new Element();
  focus(outside);
  assert.equal(outside.attributes.has(marker), false, 'ordinary pointer focus is not restyled');

  modal.open = true;
  focus(close);
  const inner = new Element('DIALOG');
  const innerClose = new Element();
  innerClose.modal = inner;
  focus(innerClose);
  inner.open = false;
  focus(close);
  emit('close', inner);
  assert.ok(close.attributes.has(marker), 'nested return stays within the outer modal');
  emit('keydown');
  modal.open = false;
  focus(outside);
  assert.equal(outside.attributes.has(marker), false, 'keyboard close keeps return indication');

  modal.open = true;
  focus(close);
  emit('pointerdown');
  modal.isConnected = false;
  focus(outside);
  assert.ok(outside.attributes.has(marker), 'detached dialogs also release focus');
  dispose();
  assert.equal(outside.attributes.has(marker), false);
  modal.isConnected = true;
  focus(close);
  emit('pointerdown');
  assert.equal(close.attributes.has(marker), false, 'dispose removes observers');
});
