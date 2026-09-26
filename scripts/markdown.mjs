import GithubSlugger from 'github-slugger';
import { fromHtml } from 'hast-util-from-html';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export function markdownTree(source) {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

export function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export function nodeText(node) {
  if (node.type === 'html') return '';
  if (node.children) return node.children.map(nodeText).join('');
  return node.value ?? node.alt ?? '';
}

export function documentTargets(source) {
  const anchors = new Set();
  const links = [];
  const slugger = new GithubSlugger();
  walk(markdownTree(source), node => {
    if (node.type === 'heading') anchors.add(slugger.slug(nodeText(node)));
    if (['link', 'image', 'definition'].includes(node.type)) {
      links.push({ target: node.url, line: node.position.start.line });
    }
    if (node.type !== 'html') return;
    walk(fromHtml(node.value, { fragment: true }), element => {
      if (element.type !== 'element') return;
      const { id, name, href, src } = element.properties;
      if (typeof id === 'string') anchors.add(id);
      if (element.tagName === 'a' && typeof name === 'string') anchors.add(name);
      for (const target of [href, src]) {
        if (typeof target === 'string') links.push({
          target, line: node.position.start.line + (element.position?.start.line ?? 1) - 1,
        });
      }
    });
  });
  return { anchors, links };
}
