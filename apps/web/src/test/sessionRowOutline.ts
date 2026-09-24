// Reads the rendered structure of sidebar rows from static markup, so
// tests can assert the two-line reading order without a DOM implementation.
interface Node { tag: string; attrs: Record<string, string>; children: Node[]; text: string }

const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parse(html: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const pattern = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (const match of html.matchAll(pattern)) {
    const [, closing, tag, rawAttrs, selfClosing, text] = match;
    if (text !== undefined) {
      for (const node of stack) node.text += decode(text);
      continue;
    }
    if (closing) { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const [, name, value] of rawAttrs.matchAll(/([\w-:]+)(?:="([^"]*)")?/g)) attrs[name] = decode(value ?? '');
    const node: Node = { tag, attrs, children: [], text: '' };
    stack.at(-1)!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function all(node: Node, predicate: (value: Node) => boolean, found: Node[] = []): Node[] {
  for (const child of node.children) {
    if (predicate(child)) found.push(child);
    all(child, predicate, found);
  }
  return found;
}
const hasClass = (node: Node, name: string) => (node.attrs.class ?? '').split(' ').includes(name);
const child = (node: Node, name: string) => node.children.find(value => hasClass(value, name));

export function sessionRowOutline(html: string) {
  return all(parse(html), node => node.tag === 'button' && hasClass(node, 'chatlist-chat')).map(row => {
    const title = child(row, 'session-row-title');
    const details = child(row, 'session-row-details');
    const directory = details && child(details, 'dialog-subtitle');
    const roles = details && child(details, 'dialog-roles');
    const meta = details && child(details, 'dialog-meta');
    return {
      id: row.attrs['data-session-id'],
      className: row.attrs.class,
      lines: row.children.map(value => value.attrs.class),
      details: details?.children.map(value => value.attrs.class) ?? [],
      title: { text: title?.text, hover: title?.attrs.title },
      titleTime: title?.attrs['data-time'],
      time: child(row, 'dialog-time')?.text,
      directory: { text: directory?.text, hover: directory?.attrs.title },
      roles: roles ? all(roles, node => hasClass(node, 'role-badge')).map(badge => badge.attrs.title) : [],
      status: meta ? all(meta, node => 'data-activity' in node.attrs).map(node => node.attrs['data-activity']) : [],
      unread: meta ? all(meta, node => 'data-sidebar-unread' in node.attrs).length : 0,
      text: row.text,
    };
  });
}
