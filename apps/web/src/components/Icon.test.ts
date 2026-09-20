import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { Icon, type IconName } from './Icon';

test('every semantic icon is a decorative local Lucide SVG with the same complete viewBox', () => {
  const names: IconName[] = ['search', 'compose', 'newchat', 'delete', 'back', 'close', 'check',
    'arrow_up', 'more', 'down', 'up', 'reload', 'sending', 'error', 'menu', 'skills', 'thought', 'mcp',
    'file', 'folder', 'mode_plan', 'radiooff', 'copy', 'stop', 'clock', 'unknown',
    'chevron_right', 'play', 'success', 'loading'];
  for (const name of names) {
    const html = renderToStaticMarkup(createElement(Icon, { name }));
    assert.match(html, /class="ck-icon"/);
    assert.match(html, /viewBox="0 0 24 24"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /focusable="false"/);
    assert.equal((html.match(/<svg /g) ?? []).length, 1);
    assert.doesNotMatch(html, /tgico|<use|<image|<title/);
  }
});

test('skills use BookOpen while thoughts retain Lightbulb', () => {
  const skills = renderToStaticMarkup(createElement(Icon, { name: 'skills' }));
  const thought = renderToStaticMarkup(createElement(Icon, { name: 'thought' }));
  assert.match(skills, /lucide-book-open/);
  assert.doesNotMatch(skills, /lucide-lightbulb/);
  assert.match(thought, /lucide-lightbulb/);
  assert.doesNotMatch(thought, /lucide-book-open/);
});

test('Module UI v1 publishes common primitives without private ancestors or icon fonts', () => {
  const css = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  for (const name of ['button', 'icon-button', 'input', 'icon', 'icon-sm', 'icon-md', 'icon-lg',
    'text-primary', 'text-secondary', 'danger', 'primary']) assert.ok(css.includes(`.ck-${name}`));
  assert.match(css, /pointer: coarse/);
  assert.match(css, /--ck-control-size: 44px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /:disabled/);
  assert.match(css, /stroke-width: var\(--ck-icon-stroke\)/);
  assert.doesNotMatch(css, /\.chat|\.cf-|@font-face/);
  const chat = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(chat, /\.chat-ask-choice \{[^}]*justify-content: flex-start;/,
    'shared flex buttons must preserve the existing left-aligned answer choices');
  assert.doesNotMatch(chat, /queue-chevron/);
  const management = compile(new URL('../styles/components/manage.scss', import.meta.url).pathname).css;
  assert.match(management, /\.manage-row-sub \{[^}]*display: block;/);
  assert.match(management, /\.switch \{[^}]*height: var\(--ck-control-size\)/);
  assert.match(management, /\.switch::before \{[^}]*height: 1.4rem;/,
    'the shared switch target must not stretch its original visual track');
});

test('the pinned Lucide license is retained verbatim in distributable Web assets', () => {
  const license = readFileSync(new URL('../../public/licenses/lucide.txt', import.meta.url), 'utf8');
  assert.equal(license, readFileSync(new URL('../../node_modules/lucide-react/LICENSE', import.meta.url), 'utf8'));
  for (const extension of ['ttf', 'woff']) {
    assert.equal(existsSync(new URL(`../../public/assets/fonts/tgico.${extension}`, import.meta.url)), false);
  }
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies['lucide-react'], '1.46.0');
});
