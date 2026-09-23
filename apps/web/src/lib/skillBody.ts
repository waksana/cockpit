// SKILL.md starts with YAML frontmatter whose name/description are already
// presented as structured fields. Only a closed block at the very start counts;
// later `---` lines are Markdown and unclosed openers are left untouched.
const LEADING_FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:[^\r\n]*\r?\n)*?---[ \t]*(?:\r?\n|$)/;

export function skillBodyContent(file: string): string {
  const match = LEADING_FRONTMATTER.exec(file);
  return match ? file.slice(match[0].length) : file;
}
