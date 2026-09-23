// Classic UI style guardrails (docs/frontend-guidelines.md#style-guardrails).
// Only classic sources are linted: the experimental /next/ UI and its lab keep
// their own Tailwind/shadcn stack. tokens.scss is the single place that defines
// raw colors and the legacy tweb aliases, so it is exempt.
import stylelint from 'stylelint';

// tweb names kept in tokens.scss only as aliases of the --host-color-* roles.
export const legacyTokens = [
  'primary-color', 'light-primary-color', 'primary-text-color', 'secondary-text-color',
  'tertiary-text-color', 'surface-color', 'body-background-color', 'background-color',
  'background-color-true', 'border-color', 'link-color', 'danger-color', 'green-color',
  'warning-color', 'ripple-color', 'badge-text-color', 'input-search-background-color',
  'input-placeholder-color', 'scrollbar-color', 'menu-background-color',
  'menu-box-shadow-color', 'menu-box-shadow', 'selected-fill',
];
const legacyTokenUse = new RegExp(`var\\(\\s*--(${legacyTokens.join('|')})\\s*[,)]`, 'g');

const legacyRule = 'cockpit/no-legacy-tokens';
const legacyMessages = stylelint.utils.ruleMessages(legacyRule, {
  rejected: (name) => `Use a --host-color-* role instead of the legacy tweb token "--${name}"`,
});
const noLegacyTokens = stylelint.createPlugin(legacyRule, (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkDecls((decl) => {
    for (const match of decl.value.matchAll(legacyTokenUse)) {
      stylelint.utils.report({ ruleName: legacyRule, result, node: decl, word: match[0], message: legacyMessages.rejected(match[1]) });
    }
  });
});

// Raw 0-2px stays allowed for hairlines and optical offsets. rem/em are not
// flagged: existing typographic rhythm (e.g. prose margins in em) is relative on
// purpose, and a hard rule there would mostly produce noise.
const rawSpacingPx = /(?:^|[\s(,+*/-])(?:[3-9]|\d{2,})(?:\.\d+)?px\b/;

// Allowlists (whole files, with reasons). Prefer a scoped, described
// `stylelint-disable-next-line <rule> -- <reason>` for a single intentional value.
const portedTweb = ['src/styles/base.scss', 'src/styles/primitives/button.scss', 'src/styles/primitives/menu.scss'];
// chat.scss (#159) and sidebar.scss (#158) are being changed in parallel; migrate
// their legacy names, raw spacing and chat contrast hex overrides in a follow-up.
const inFlight = ['src/styles/components/chat.scss', 'src/styles/components/sidebar.scss'];
// Dev-only Chat Lab chrome, never loaded by the shipped classic entry.
const devLab = ['src/dev/chat-lab.scss'];

export default {
  customSyntax: 'postcss-scss',
  plugins: [noLegacyTokens],
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  reportInvalidScopeDisables: true,
  ignoreFiles: ['src/next/**', 'src/dev/next-lab.css', 'next/**', 'dist/**', 'dist-review/**', 'src/styles/tokens.scss'],
  rules: {
    'color-no-hex': [true, { message: 'Use a --host-color-* role (tokens.scss) instead of a hex color' }],
    'color-named': ['never', { message: 'Use a --host-color-* role (tokens.scss) instead of a named color' }],
    'function-disallowed-list': [
      ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch'],
      { message: 'Use a --host-color-* role (tokens.scss) instead of a raw color function' },
    ],
    [legacyRule]: true,
    'declaration-property-value-disallowed-list': [
      { '/^(margin|padding|gap|row-gap|column-gap|inset)(-|$)/': [rawSpacingPx] },
      { message: 'Use a spacing token (--host-space-*, --ck-*, component tokens) instead of a raw px value' },
    ],
  },
  overrides: [
    { files: portedTweb, rules: { [legacyRule]: null } },
    { files: inFlight, rules: { 'color-no-hex': null, [legacyRule]: null, 'declaration-property-value-disallowed-list': null } },
    { files: devLab, rules: { [legacyRule]: null, 'declaration-property-value-disallowed-list': null } },
  ],
};
