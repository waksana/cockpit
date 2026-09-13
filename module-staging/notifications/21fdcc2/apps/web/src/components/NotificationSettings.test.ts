import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The component imports SCSS, which the existing Node test runner cannot load.
// Check its source contract without adding a loader or shimming controller types.
const source = readFileSync(new URL('./NotificationSettings.tsx', import.meta.url), 'utf8');
const normalized = source.replace(/\s+/g, ' ');

function gate(name: string) {
  const match = normalized.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(match, `Missing ${name} gate`);
  return match[1];
}

function button(label: string) {
  const match = [...source.matchAll(/<button\b[\s\S]*?<\/button>/g)]
    .find(([markup]) => markup.includes(`>${label}</button>`)
      || new RegExp(`>\\s*${label}\\s*</button>`).test(markup));
  assert.ok(match, `Missing ${label} button`);
  return match[0].replace(/\s+/g, ' ');
}

test('initial enable allows unknown configuration and does not require an existing registration', () => {
  assert.equal(gate('canEnable'),
    "!state.busy && state.supported && state.permission !== 'denied' && state.configured !== false && !state.ready");
  const enable = button('启用通知');
  assert.match(enable, /aria-disabled=\{!canEnable\}/);
  assert.match(enable, /onClick=\{\(\) => \{ if \(canEnable\) void onEnable\(\)\.catch\(controllerHandlesError\); \}\}/);
});

test('disable remains retryable for false or unknown registration and every partial failure', () => {
  assert.equal(gate('canDisable'), '!state.busy');
  const disable = button('停用通知');
  assert.match(disable, /aria-disabled=\{!canDisable\}/);
  assert.match(disable, /onClick=\{\(\) => \{ if \(canDisable\) void onDisable\(\)\.catch\(controllerHandlesError\); \}\}/);
});

test('testing requires readiness, configured push, registered endpoint and granted permission', () => {
  assert.equal(gate('canTest'),
    "state.ready && !state.busy && state.supported && state.configured === true && state.registered === true && state.permission === 'granted'");
  assert.match(normalized,
    /<input type="checkbox" checked=\{testConfirmed\} aria-disabled=\{!canTest\} onChange=\{\(event\) => \{ if \(canTest\) setTestConfirmed\(event.target.checked\); \}\}/);
});

test('test notification requires explicit confirmation and consumes it before sending', () => {
  assert.match(normalized, /const \[testConfirmed, setTestConfirmed\] = useState\(false\);/);
  assert.match(normalized, /我确认向当前设备发送一条测试通知/);
  const send = button('发送测试通知');
  assert.match(send, /aria-disabled=\{!canTest \|\| !testConfirmed\}/);
  assert.match(send,
    /onClick=\{\(\) => \{ if \(!canTest \|\| !testConfirmed\) return; setTestConfirmed\(false\); void onTest\(true\)\.catch\(controllerHandlesError\); \}\}/);
  assert.equal(source.match(/\bonTest\s*\(/g)?.length, 1);
});

test('readiness is distinct from delivery and a disabled device is not a settings failure', () => {
  assert.match(normalized, /<dt>设备通知偏好<\/dt><dd>\{state.disabled \? '已停用（存储失败时仅当前页面）' : '未停用'\}<\/dd>/);
  assert.match(normalized, /<dt>推送状态<\/dt><dd>\{state.ready \? '已就绪' : '未就绪'\}<\/dd>/);
  assert.match(normalized, /服务接受不代表设备已收到/);
  assert.match(normalized, /推送服务已接受，仍需确认设备收到/);
  assert.match(normalized, /state.disabled && ' · 本设备已停用'/);
  assert.doesNotMatch(source, /通知设置尚未就绪/);
});

test('operations precede optional eight-field diagnostics without hiding simultaneous blockers or delivery failure', () => {
  assert.ok(source.indexOf('刷新状态\n') < source.indexOf('notification-settings-details'));
  assert.match(source, /aria-expanded=\{showDeviceState\}/);
  assert.match(source, /hidden=\{!showDeviceState\}/);
  assert.equal(source.match(/<dt>/g)?.length, 8);
  for (const condition of ["!state.supported", "state.permission === 'denied'", "state.permission === 'default'",
    "state.configured === false", "state.configured === null", "state.registered === false", "state.registered === null"]) {
    assert.ok(source.includes(condition), condition);
  }
  const testArea = source.slice(source.indexOf('<div className="notification-settings-test">'));
  assert.match(testArea, /state.lastDelivery && <p className="dialog-message" role="status">/);
  assert.match(source, /state.error && <p className="dialog-message notification-settings-error" role="alert"/);
  assert.match(source, /处理中…仍可关闭此窗口/);
});
