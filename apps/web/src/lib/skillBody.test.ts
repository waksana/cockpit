import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillBodyContent } from './skillBody';

test('skill body frontmatter stripping keeps non-frontmatter Markdown intact', () => {
  for (const [input, expected] of [
    ['# Title\n\nBody', '# Title\n\nBody'],
    ['---\nname: a\ndescription: b\n---\n', ''],
    ['---\nname: a\n---', ''],
    ['---\n---\nBody', 'Body'],
    ['---\nname: a\n---\n# T\n\n---\n\nlater', '# T\n\n---\n\nlater'],
    ['---\r\nname: a\r\ndescription: b\r\n---\r\n# T\r\n---\r\nx', '# T\r\n---\r\nx'],
    ['\uFEFF---\nname: a\n---\nBody', 'Body'],
    ['--- \nname: a\n---\t\nBody', 'Body'],
    ['---\nname: a\nno closing line', '---\nname: a\nno closing line'],
    ['\n---\nname: a\n---\nBody', '\n---\nname: a\n---\nBody'],
    ['Intro\n---\nname: a\n---\n', 'Intro\n---\nname: a\n---\n'],
    ['---\nname: a\n---more\nBody', '---\nname: a\n---more\nBody'],
    ['----\nname: a\n----\nBody', '----\nname: a\n----\nBody'],
  ] as const) assert.equal(skillBodyContent(input), expected, JSON.stringify(input));
});
