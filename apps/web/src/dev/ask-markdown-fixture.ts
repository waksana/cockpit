export const askMarkdownQuestion = `## 选择实现方案

请保留 **原始选项**、*自由回复* 与 \`ask_user\` 的语义，~~不要替换字符串~~。
阅读 [说明](/synthetic/ask-guide) 后选择。

- 问题和历史使用同一渲染器。
- 代码与表格不撑宽页面。

1. 先阅读内容。
2. 再明确提交。

\`\`\`ts
const value = "${'long_argument_'.repeat(18)}";
\`\`\`

| 项目 | 输入 | 保存 | 展示 | 操作 | 结果 |
| --- | --- | --- | --- | --- | --- |
| Markdown | 原始文本 | 不变 | 常用格式 | 明确选择 | 原值提交 |

> 普通文字与中文换行都应自然显示。`;

export const askMarkdownChoices = [
  '**保留现有实现**，使用 `pnpm test`（推荐）。',
  '**查看细节**\n\n阅读 [参考说明](/synthetic/ask-guide) 后选择。\n\n'
    + '```sh\npnpm --filter @cockpit/web test\n```\n\n'
    + '| 项目 | 条件 |\n| --- | --- |\n| 字符串 | 原样提交 |\n| 长标识 | ' + 'unbroken_choice_'.repeat(20) + ' |',
  '普通选项，不含 Markdown。',
];
