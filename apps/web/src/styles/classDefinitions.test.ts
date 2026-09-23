import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compile } from 'sass';
import ts from 'typescript';

// UI guardrail (docs/frontend-guidelines.md#style-guardrails): every
// static class token written in TSX must be styled somewhere in the
// host stylesheets, or be listed below with a reason. This keeps unstyled
// marker classes such as the retired `dialog-btn` from reappearing.

const src = fileURLToPath(new URL('..', import.meta.url));

const hostStyles = ['styles/index.scss', 'components/UxErrorNotifications.scss', 'dev/chat-lab.scss'];

// Classes the host styles nowhere on purpose. Keep each entry justified.
// Prefer styling or deleting a class over adding it here.
const hook = 'test/state hook read by lifecycle or presentation tests';
const owner = 'owner name on a shared component; the component class carries the style';
const allowed = new Map<string, string>([
  ['chat-copy-icon', hook],
  ['chat-copy-label-text', hook],
  ['chat-controls-list', hook],
  ['chat-interrupt', hook],
  ['chat-typing-stop', hook],
  ['manage-error-summary', hook],
  ['thought-toggle', hook],
  ['tool-toggle', hook],
  ['msg-thought', hook],
  ['detail-pane-body', owner],
  ['master-pane-scroll', owner],
  ['sidebar-header', owner],
  ['manage-body', `${owner}; PanePresentation.test keeps it intentionally unstyled`],
  ['chat-pending', 'semantic root of the styled chat-pending-* parts'],
  ['info-section-name', 'semantic hook on SectionHeading; the ck-heading appearance is shared'],
  ['info-section-content', 'semantic hook; layout comes from the sibling info-controls/info-meta-* classes'],
  ['info-model-eyebrow', 'semantic label inside the styled info-model-current row'],
  ['lab-async-card', 'dev-only fixture hook; ck-surface carries the style'],
]);

// Class names retired by #154; they must not come back even with a definition.
const retired = ['dialog-btn', 'rp', 'primary'];

const walk = (dir: string, out: string[] = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
};

function definedClasses() {
  const defined = new Set<string>();
  for (const file of hostStyles) {
    const css = compile(join(src, file)).css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, prelude] of css.matchAll(/([^{};]+)\{/g)) {
      if (prelude.trim().startsWith('@')) continue;
      // Read escaped identifiers too, e.g. `.lg\:hidden` defines `lg:hidden`.
      for (const [, name] of prelude.matchAll(/\.(-?(?:[_a-zA-Z]|\\.)(?:[\w-]|\\.)*)/g)) defined.add(name.replace(/\\(.)/g, '$1'));
    }
  }
  return defined;
}

const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword,
]);

type Use = { token: string; file: string; line: number };

const usedClasses = (file: string) => scanClasses(readFileSync(file, 'utf8'), relative(src, file));

function scanClasses(text: string, file: string): Use[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const uses: Use[] = [];
  const add = (raw: string, node: ts.Node, openStart: boolean, openEnd: boolean) => {
    const parts = raw.split(/\s+/);
    parts.forEach((token, i) => {
      if (!token) return;
      // A token glued to a ${} substitution is only a fragment of a class name.
      if ((i === 0 && openStart) || (i === parts.length - 1 && openEnd)) return;
      uses.push({ token, file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    });
  };
  const collect = (node: ts.Node, seen: Set<string>) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text, node, false, false);
    else if (ts.isTemplateExpression(node)) {
      add(node.head.text, node.head, false, true);
      node.templateSpans.forEach((span) => {
        collect(span.expression, seen);
        add(span.literal.text, span.literal, true, ts.isTemplateMiddle(span.literal));
      });
      return;
    } else if (ts.isIdentifier(node) && !seen.has(node.text)) {
      // Follow a local class list such as `const cls = ['message']; cls.push('is-x')`.
      seen.add(node.text);
      for (const source of localSources(node.text)) collect(source, seen);
    } else if (ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)) {
      // `variant === 'value'` compares a value; it never yields a class.
      return;
    } else if (ts.isCallExpression(node)) {
      node.arguments.forEach((arg) => collect(arg, seen));
      if (ts.isPropertyAccessExpression(node.expression)) collect(node.expression.expression, seen);
      return;
    } else if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue, seen);
      collect(node.whenFalse, seen);
      return;
    }
    if (!ts.isIdentifier(node)) ts.forEachChild(node, (child) => collect(child, seen));
  };
  const localSources = (name: string) => {
    const found: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
        && (ts.isArrayLiteralExpression(node.initializer) || ts.isStringLiteralLike(node.initializer) || ts.isTemplateExpression(node.initializer))) {
        found.push(node.initializer);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'push'
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === name) {
        found.push(...node.arguments);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && /^(className|\w+ClassName)$/.test(node.name.getText(sf)) && node.initializer) {
      collect(node.initializer, new Set());
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

const hostTsx = () => walk(src).filter((path) => path.endsWith('.tsx'));

test('every static class used in TSX is styled or explicitly allowed', () => {
  const defined = definedClasses();
  const missing = new Map<string, string[]>();
  for (const file of hostTsx()) {
    for (const { token, file: name, line } of usedClasses(file)) {
      if (defined.has(token) || allowed.has(token)) continue;
      missing.set(token, [...(missing.get(token) ?? []), `${name}:${line}`]);
    }
  }
  const report = [...missing].map(([token, where]) => `  ${token}  (${where.join(', ')})`).join('\n');
  assert.equal(missing.size, 0, `Unstyled class names in TSX. Style them, remove them, or allow them with a reason in ${relative(src, fileURLToPath(import.meta.url))}:\n${report}`);
});

test('the class allowlist only lists classes that are still used and still unstyled', () => {
  const defined = definedClasses();
  const used = new Set(hostTsx().flatMap((file) => usedClasses(file).map((use) => use.token)));
  for (const [token, reason] of allowed) {
    assert.ok(reason.trim(), `${token} needs a reason`);
    assert.ok(used.has(token), `${token} is no longer used; remove it from the allowlist`);
    assert.ok(!defined.has(token), `${token} is now styled; remove it from the allowlist`);
  }
});

test('the class scanner sees literal, conditional, template and local-list classes', () => {
  const tokens = (code: string) => scanClasses(code, 'x.tsx').map((use) => use.token).sort();
  assert.deepEqual(tokens(`<a className="one two" />`), ['one', 'two']);
  assert.deepEqual(tokens(`<a className={v === 'value' ? 'yes' : "no"} />`), ['no', 'yes']);
  assert.deepEqual(tokens(`<a className={ok && 'shown'} />`), ['shown']);
  assert.deepEqual(tokens('<a className={`base ck-icon-${size} ${open ? "open" : ""} tail`} />'), ['base', 'open', 'tail']);
  assert.deepEqual(tokens(`<a bodyClassName="body" className={['x', c].filter(Boolean).join(' ')} />`), ['body', 'x']);
  assert.deepEqual(tokens(`const cls = ['message']; if (a) cls.push('is-a'); <a className={cls.join(' ')} />`), ['is-a', 'message']);
  assert.deepEqual(tokens(`<a data-x="not-a-class" title="t" />`), []);
  assert.ok(definedClasses().has('lg:hidden'), 'escaped selectors such as .lg\\:hidden count as definitions');
});

test('host sources no longer use the retired dialog-btn, primary or rp classes', () => {
  for (const file of walk(src).filter((path) => /\.(tsx|scss)$/.test(path))) {
    if (file.endsWith('.tsx')) {
      const tokens = usedClasses(file).map((use) => use.token);
      for (const name of retired) assert.ok(!tokens.includes(name), `${relative(src, file)} uses retired class ${name}`);
    } else {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\.(?:dialog-btn|rp)\b(?![\w-])/, file);
    }
  }
});
