import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function cssBlocks(css: string): string[] {
  return css.split('}');
}

function listFiles(pattern: string): string[] {
  return [...new Glob(pattern).scanSync({ cwd: root })].sort();
}

/** Every web stylesheet: the CSS modules plus global.css and the token sources. */
function webStylesheets(): string[] {
  return listFiles('web/src/**/*.css');
}

/** Non-test web source files. */
function webSources(): string[] {
  return listFiles('web/src/**/*.{ts,tsx}').filter((path) => !/\.test\.tsx?$/.test(path));
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every animation* and transition* declaration, comments stripped. */
function motionDeclarations(css: string): string[] {
  return [...stripCssComments(css).matchAll(/(?:^|[;{\s])((?:animation|transition)(?:-[a-z-]+)?\s*:[^;{}]*)/g)]
    .map((match) => (match[1] ?? '').trim());
}

/** The bodies of every @keyframes rule, comments stripped. */
function keyframeBodies(css: string): string[] {
  const text = stripCssComments(css);
  const bodies: string[] = [];
  for (const match of text.matchAll(/@keyframes\s+[\w-]+\s*\{/g)) {
    let depth = 1;
    let at = match.index + match[0].length;
    const start = at;
    while (at < text.length && depth > 0) {
      if (text[at] === '{') depth += 1;
      else if (text[at] === '}') depth -= 1;
      at += 1;
    }
    bodies.push(text.slice(start, at - 1));
  }
  return bodies;
}

describe('design system drift guards', () => {
  test('shared button variants own icon, tile, and star action vocabularies', () => {
    const buttons = read('web/src/styles/buttons.module.css');

    expect(buttons).toContain('.iconAction');
    expect(buttons).toContain('[data-size=\'22\']');
    expect(buttons).toContain('[data-size=\'26\']');
    expect(buttons).toContain('[data-size=\'28\']');
    expect(buttons).toContain('.tileAction');
    expect(buttons).toContain('.starBtn');
    expect(buttons).toContain('[data-pinned=\'true\']');

    for (const path of [
      'web/src/components/Sidebar/index.module.css',
      'web/src/components/Batch/index.module.css',
      'web/src/components/tile/ImageTile/index.module.css',
      'web/src/components/Archive/index.module.css',
    ]) {
      expect(read(path)).not.toMatch(/^\.iconBtn|^\.tileBtn|^\.pinBtn/m);
    }
  });

  test('menu rows compose the one menuShell row variant', () => {
    const shell = read('web/src/styles/menuShell.module.css');
    expect(shell).toMatch(/(^|\n)\.row \{/);
    expect(shell).toMatch(/(^|\n)\.groupLabel \{\s*composes: label from '\.\/type\.module\.css';/);
    for (const path of [
      'web/src/components/OverflowMenu/index.module.css',
      'web/src/components/MovePopover/index.module.css',
    ]) {
      const blocks = cssBlocks(read(path));
      const row = blocks.find((block) => /(^|\n)\.row \{/.test(block)) ?? '';
      expect(row).toContain("composes: row from '../../styles/menuShell.module.css';");
      // The shared states live in the shell; owners keep only their own.
      expect(blocks.filter((block) => /\.row:(hover|focus-visible|active|disabled)/.test(block))).toEqual([]);
    }
  });

  test('Archive tiles compose the feed tile shell without replaying mount entrances', () => {
    const archive = cssBlocks(read('web/src/components/Archive/index.module.css'));
    const tile = archive.find((block) => /(^|\n)\.tile \{/.test(block)) ?? '';
    expect(tile).toContain("composes: shell from '../tile/shell.module.css';");
    expect(tile).not.toContain('background:');
    expect(tile).toContain('animation: none;');
    expect(tile).not.toContain('transition:');
  });

  test('screen-reader-only utility lives in global styles, not component modules', () => {
    expect(read('web/src/styles/global.css')).toContain('.srOnly');

    for (const path of [
      'web/src/App.module.css',
      'web/src/components/SaveTemplateDialog/index.module.css',
      'web/src/components/DescribeDialog/index.module.css',
      'web/src/components/PromptManager/index.module.css',
      'web/src/components/PromptPicker/index.module.css',
      'web/src/components/Sidebar/index.module.css',
      'web/src/components/MovePopover/index.module.css',
    ]) {
      expect(read(path)).not.toMatch(/^\.srOnly\b/m);
    }
  });

  test('scroll-fade mask is declared once and carries no opaque hex literal', () => {
    expect(read('web/src/styles/global.css')).toContain('--scroll-fade-mask: linear-gradient(to bottom, transparent 0, black 14px');
    for (const path of [
      'web/src/components/PromptManager/index.module.css',
      'web/src/components/PromptPicker/index.module.css',
    ]) {
      expect(read(path)).not.toContain('#000');
      expect(read(path)).toContain('mask-image: var(--scroll-fade-mask);');
    }
  });

  test('the aurora placeholder material is gone; loaders and rests are the monochrome plate', () => {
    const offenders = [...webStylesheets(), ...webSources()].filter((path) => read(path).includes('--aurora'));
    expect(offenders).toEqual([]);
  });

  test('only components/Etching sets an artwork mask (scroll-fade masks stay legal)', () => {
    // A mask / mask-image declaration (any vendor prefix) whose value carries a
    // url(); the --scroll-fade-mask gradients have none.
    const declaration = /(?:^|[\s;{])(?:-webkit-)?mask(?:-image)?\s*:\s*([^;}]*)/g;
    const inline = /\bmask(?:Image)?\s*:\s*[^,}]*url\(/i;
    const offenders: string[] = [];
    for (const path of webStylesheets()) {
      if (path.startsWith('web/src/components/Etching/')) continue;
      const css = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(declaration)) {
        if ((match[1] ?? '').includes('url(')) offenders.push(`${path}: ${match[0].trim()}`);
      }
    }
    for (const path of webSources()) {
      if (path.startsWith('web/src/components/Etching/')) continue;
      if (inline.test(read(path))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // The owner does set it, both prefixed and unprefixed.
    const etching = read('web/src/components/Etching/index.module.css');
    expect(etching).toContain('mask: var(--etch-url) center / contain no-repeat;');
    expect(etching).toContain('-webkit-mask: var(--etch-url) center / contain no-repeat;');
  });

  test('etched art assets are imported only by components/Etching', () => {
    const importers = [...webSources(), ...webStylesheets()].filter((path) => read(path).includes('assets/etch/'));
    expect(importers).toEqual(['web/src/components/Etching/index.tsx']);
  });

  test('mono font declarations use tabular numerals', () => {
    const paths = [
      'web/src/App.module.css',
      'web/src/styles/dialog.module.css',
      'web/src/styles/global.css',
      'web/src/styles/type.module.css',
      'web/src/components/Archive/index.module.css',
      'web/src/components/Composer/EnhanceControl.module.css',
      'web/src/components/Composer/index.module.css',
      'web/src/components/ErrorBoundary/index.module.css',
      'web/src/components/InfiniteStatus/index.module.css',
      'web/src/components/Lightbox/index.module.css',
      'web/src/components/ManagedViewHeader/index.module.css',
      'web/src/components/MovePopover/index.module.css',
      'web/src/components/PromptManager/CoverageCard/index.module.css',
      'web/src/components/PromptManager/DimensionProposal/index.module.css',
      'web/src/components/PromptManager/index.module.css',
      'web/src/components/PromptPicker/index.module.css',
      'web/src/components/SaveTemplateDialog/index.module.css',
      'web/src/components/Sidebar/index.module.css',
      'web/src/components/StateView/index.module.css',
      'web/src/components/Toast/index.module.css',
      'web/src/components/tile/FailedTile/index.module.css',
      'web/src/components/tile/ImageTile/index.module.css',
      'web/src/components/tile/LoadingTile/index.module.css',
    ];

    for (const path of paths) {
      const blocks = cssBlocks(read(path)).filter((block) => block.includes('font-family: var(--mono)'));
      for (const block of blocks) {
        expect(block).toContain('font-variant-numeric: tabular-nums');
      }
    }
  });

  test('no web stylesheet sets tracked uppercase; labels compose type.module.css .label', () => {
    for (const path of webStylesheets()) {
      expect({ path, uppercase: /text-transform:\s*uppercase/.test(read(path)) }).toEqual({ path, uppercase: false });
    }
  });

  test('no source file joins fields with a middle dot; Meta lists or word forms do', () => {
    // Accessible names included: a screen reader reads the dot aloud or runs
    // the fields together, so labels use words and commas too.
    const offenders = webSources()
      .flatMap((path) => read(path).split('\n').map((line, index) => ({ path, line: index + 1, text: line })))
      .filter(({ text }) => text.includes('·'));
    expect(offenders).toEqual([]);
  });

  test('the mono face is reserved for kbd, template tokens and the resolved-prompt body', () => {
    // Selector (the text before `{`) of every rule that sets the mono face,
    // keyed by file. Anything else (seeds, counts, ids, labels) is sans.
    const allowed: Record<string, readonly string[]> = {
      'web/src/styles/type.module.css': ['.kbd'],
      'web/src/components/StateView/index.module.css': ['.state code', '.state kbd'],
      'web/src/components/PromptManager/index.module.css': [
        '.microcopy code',
        '.monoArea',
        '.chip,\n.dangerChip',
        '.helpBody code',
      ],
      'web/src/components/PromptPicker/index.module.css': ['.templateButton code', '.preview'],
      'web/src/components/SaveTemplateDialog/index.module.css': ['.preview'],
    };
    const found: Record<string, string[]> = {};
    for (const path of webStylesheets()) {
      const selectors = cssBlocks(read(path))
        .filter((block) => block.includes('font-family: var(--mono)'))
        .map((block) => (block.split('{')[0] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
      if (selectors.length > 0) found[path] = selectors;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(allowed).map(([path, selectors]) => [path, [...selectors]])));
  });

  test('content-column inset is tokenized so portaled overlays centre over the composer', () => {
    expect(read('docs/handoff/design/index.html')).toContain('--sidebar-width: 240px;');
    expect(read('web/src/styles/tokens.css')).toContain('--sidebar-width: 240px;');
    expect(read('web/src/App.module.css')).toContain('grid-template-columns: var(--sidebar-width) minmax(0, 1fr);');
    // The content inset derives from the sidebar-width token in CSS, not a
    // hardcoded literal, so a token change propagates to the overlays.
    expect(read('web/src/styles/global.css')).toContain('--content-inset-left: var(--sidebar-width);');
    // Body-portaled overlays (toast + Library popover) centre over the content
    // column via the same --content-inset-left var, not the raw viewport: auto
    // margins between that inset and the right edge, plain layout with no
    // centring transform. The toast does the same as its nonanchored base.
    const toast = read('web/src/components/Toast/index.module.css');
    const stack = cssBlocks(toast).find((block) => /(^|\n)\.stack \{/.test(block)) ?? '';
    expect(stack).toContain('left: var(--content-inset-left, 0px);');
    expect(stack).toContain('margin-inline: auto;');
    expect(stack).not.toMatch(/^\s*transform:/m);
    const picker = read('web/src/components/PromptPicker/index.module.css');
    const popover = cssBlocks(picker).find((block) => /(^|\n)\.popover \{/.test(block)) ?? '';
    expect(popover).toContain('left: var(--content-inset-left, 0px);');
    expect(popover).toContain('right: 0;');
    expect(popover).toContain('margin-inline: auto;');
    expect(popover).not.toMatch(/^\s*transform:/m);
    expect(toast).not.toContain('calc(50% + 120px)');
  });

  test('breakpoint tally and enhance control icon stay aligned with the design contract', () => {
    expect(read('docs/web-conventions.md')).toContain('hardcoded across four update categories');
    expect(read('docs/web-conventions.md')).toContain('web/src/styles/buttons.module.css');
    expect(read('web/src/components/Composer/EnhanceControl.tsx')).not.toContain('↺');
    expect(read('web/src/components/Composer/EnhanceControl.tsx')).not.toContain('✦');
    expect(read('web/src/components/Composer/EnhanceControl.tsx')).toContain('<I.sparkle aria-hidden="true" />');
  });

  test('overlay and on-dark glass values use shared tokens outside the token source files', () => {
    for (const path of [
      'web/src/styles/buttons.module.css',
      'web/src/components/Composer/index.module.css',
      'web/src/App.module.css',
      'web/src/styles/dialog.module.css',
      'web/src/components/MovePopover/index.module.css',
      'web/src/components/PromptManager/index.module.css',
      'web/src/components/PromptPicker/index.module.css',
      'web/src/components/Lightbox/index.module.css',
      'web/src/components/tile/LoadingTile/index.module.css',
      'web/src/components/tile/ImageTile/index.module.css',
    ]) {
      const css = read(path);
      expect(css).not.toMatch(/rgba\(20,\s*19,\s*15,\s*0\.(?:4|55|6|7|85)\)/);
      expect(css).not.toMatch(/rgba\(27,\s*29,\s*32,\s*0\.(?:4|55|6|7|85)\)/);
      expect(css).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.(?:06|08|1|10|12|15|34|35|65|7|85|9)\)/);
      expect(css).not.toContain('0 40px 100px -20px rgba(0,0,0,0.5)');
    }
  });

  test('element-anchored overlays are placed by native CSS anchors, not script geometry', () => {
    const geometry = /getBoundingClientRect|getClientRects|offset(Width|Height|Top|Left)|inner(Width|Height)|scroll(X|Y)|-9999|useAnchoredPosition/;
    // Top-layer owners take their implicit anchor from showPopover({ source }).
    for (const path of [
      'web/src/components/OverflowMenu/index.tsx',
      'web/src/components/MovePopover/index.tsx',
      'web/src/components/PromptPicker/AxisDropdown.tsx',
    ]) {
      const source = read(path);
      expect(source).toContain('useAnchoredPopover');
      expect(source).not.toMatch(geometry);
    }
    // ChipSelect stays under the toast stack with a declared per-instance name.
    const chip = read('web/src/components/Composer/ChipSelect.tsx');
    expect(chip).toContain("'--named-anchor'");
    expect(chip).not.toMatch(geometry);
    // So does the BatchPrompt card: page layer, below --z-toast, anchored by
    // a per-instance name its active source declares. No popover, no source.
    const card = read('web/src/components/Batch/BatchPrompt.tsx');
    expect(card).toContain("'--prompt-anchor'");
    expect(card).toContain('data-anchored="name"');
    expect(card).not.toContain('useAnchoredPopover');
    expect(card).not.toMatch(/\bpopover=|showPopover/);
    expect(card).not.toMatch(geometry);
    const cardCss = read('web/src/components/Batch/index.module.css');
    const promptTip = cssBlocks(cardCss).find((block) => /(^|\n)\.promptTip \{/.test(block)) ?? '';
    expect(promptTip).toContain('z-index: calc(var(--z-popover) + 1);');
    expect(cardCss).toContain('position-anchor: var(--prompt-anchor);');
    expect(cardCss).toContain('anchor-name: var(--prompt-anchor, none);');
    expect(cardCss).not.toContain('position-anchor: auto;');
    // Relationship and lifecycle only: neither the helper nor the tooltip
    // lifecycle measures anything.
    expect(read('web/src/hooks/useNativeAnchor.ts')).not.toMatch(geometry);
    expect(read('web/src/hooks/useTooltipDismiss.ts')).not.toMatch(geometry);
    // The desktop picker and the toast stack hang off the single Composer
    // anchor; nothing that places an overlay reads the measured --composer-top.
    expect(read('web/src/components/Composer/index.module.css')).toContain('anchor-name: --atelier-composer;');
    for (const path of ['web/src/components/PromptPicker/index.module.css', 'web/src/components/Toast/index.module.css']) {
      expect(read(path)).toContain('position-anchor: --atelier-composer;');
      expect(read(path)).not.toContain('--composer-top');
    }
  });

  test('editable name fields carry no tooltip that would echo their typing', () => {
    expect(read('web/src/components/PromptManager/InlineFieldChrome.tsx')).not.toMatch(/data-tip|dataTip/);
    for (const path of [
      'web/src/components/PromptManager/TemplateEditor.tsx',
      'web/src/components/PromptManager/ListEditor.tsx',
      'web/src/components/PromptManager/DimensionEditor.tsx',
    ]) {
      expect(read(path)).not.toMatch(/dataTip(Place)?=/);
    }
  });

  test('prompt picker axis menu uses a retained ref rather than document query lookup', () => {
    expect(read('web/src/components/PromptPicker/index.tsx')).not.toContain("document.querySelector('[data-axis-menu-root]')");
  });

  test('enhance control composes the canonical secondary button style', () => {
    expect(read('web/src/components/Composer/EnhanceControl.tsx')).toContain("from '../../styles/buttons.module.css'");
    expect(read('web/src/components/Composer/EnhanceControl.tsx')).toContain('buttons.secondary');
  });

  test('one reduced-motion rule set collapses every motion token', () => {
    const tokens = read('web/src/styles/tokens.css');
    const motion = read('web/src/styles/motion.css');
    const reducedAt = motion.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(reducedAt).toBeGreaterThan(-1);
    const reduced = motion.slice(reducedAt);
    const names = [...new Set([...tokens.matchAll(/(--(?:dur|ease|m)-[a-z-]+):/g)].map((match) => match[1] ?? ''))];
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      if (name === '--dur-reduced') continue;
      const expected = name === '--dur-transform' ? '0ms'
        : name.startsWith('--dur-') ? 'var(--dur-reduced)'
        : name.startsWith('--ease-') ? 'linear'
        : name === '--m-shift' || name === '--m-blur' ? '0px'
        : '1';
      expect(reduced).toContain(`${name}: ${expected};`);
    }
    expect(reduced).toContain('::view-transition-old(*)');
    expect(reduced).toContain('::view-transition-new(*)');
  });

  test('shared keyframes and presses read the motion tokens, not literal amplitudes', () => {
    const motion = read('web/src/styles/motion.css');
    const keyframes = motion.slice(0, motion.indexOf('@media (prefers-reduced-motion: reduce)'));
    // Sheet slides (100%) and loops are the owner-handled exceptions.
    expect(keyframes).not.toMatch(/translate[XY]?\(-?\d+(?:\.\d+)?px\)/);
    expect(keyframes).not.toMatch(/scale\((?:0|1)\.\d+\)/);
    expect(keyframes).not.toMatch(/blur\(\d/);
    for (const path of ['web/src/styles/buttons.module.css', 'web/src/styles/global.css', 'web/src/components/Toast/index.module.css']) {
      const presses = cssBlocks(read(path)).filter((block) => /:active[^{]*\{/.test(block));
      for (const block of presses) expect(block).not.toMatch(/scale\(0\.\d+\)/);
    }
  });

  test('view-transition captures are the view stage, the Composer frame, batch rows, the feed column and empty state, Archive rows, tiles and listed parts', () => {
    const motion = read('web/src/styles/motion.css');
    expect(motion).toMatch(/:root \{\s*view-transition-name: none;\s*\}/);
    expect(motion).toMatch(/::view-transition \{\s*pointer-events: none;\s*\}/);
    const app = read('web/src/App.tsx');
    expect(app).toContain('<ViewTransition key={stageKey} default="none"');
    expect(app).toContain('<ViewTransition default="none" enter="composer-enter" exit="composer-exit" update={COMPOSER_FRAME_UPDATE}>');
    // The Composer frame and mode body animate only for the Composer's own
    // typed part commits: a capture is not hit-testable, so a frame captured
    // while a batch enters the feed would swallow Generate presses.
    const composerMotion = read('web/src/lib/composerMotion.ts');
    expect(composerMotion).toContain("export const COMPOSER_FRAME_UPDATE = { [COMPOSER_PARTS_TRANSITION]: 'composer-frame', default: 'none' };");
    expect(composerMotion).toContain("export const COMPOSER_BODY_UPDATE = { [COMPOSER_PARTS_TRANSITION]: 'composer-body', default: 'none' };");
    const composer = read('web/src/components/Composer/index.tsx');
    expect(composer).toContain('<ViewTransition default="none" update={COMPOSER_BODY_UPDATE}>');
    expect(composer).toContain('addTransitionType(COMPOSER_PARTS_TRANSITION);');
    // Feed tiles and batch rows stay unnamed (React's own names), so a batch
    // that two feed scopes share never pairs across a view swap.
    const batch = read('web/src/components/Batch/index.tsx');
    expect(batch).toMatch(/<ViewTransition\s+key=\{tile\.id\}\s+default="tile-move"\s+exit="tile-exit"/);
    const canvas = read('web/src/components/Canvas/index.tsx');
    expect(canvas).toMatch(/<ViewTransition\s+default="tile-move"\s+exit="tile-exit"/);
    // The feed column and the empty state are sibling boundaries, so removing
    // the last batch exits the column and the empty state enters.
    expect(canvas).toContain(`<ViewTransition key="feed" default="none" exit={placeholder ? 'none' : 'tile-exit'}>`);
    expect(canvas).toContain('<ViewTransition key="empty" default="none" enter="part-enter">');
    for (const source of [batch, canvas]) expect(source).not.toMatch(/<ViewTransition[^>]*\bname=/);
    const archive = read('web/src/components/Archive/index.tsx');
    expect(archive).toMatch(/<ViewTransition\s+key=\{tile\.id\}\s+name=\{`tile-\$\{tile\.id\}`\}\s+share="tile-move"/);
    // Each virtual row is an exit-only boundary: deleting a row would
    // otherwise take its sole tile's exit with it.
    expect(archive).toContain('<ViewTransition key={virtualRow.key} default="none" exit="tile-exit">');
    for (const cls of ['tile-move', 'tile-exit', 'tile-enter', 'part-enter', 'part-exit', 'composer-frame', 'composer-body']) expect(motion).toContain(`(.${cls})`);
    // Conditional parts (T8b): unnamed enter/exit boundaries with no update
    // animation, each fed by its surface's deferred snapshot or a Transition.
    const partOwners = [
      'web/src/components/Composer/index.tsx',
      'web/src/components/Composer/RefImageRow.tsx',
      'web/src/components/Composer/InFlightIndicator.tsx',
      'web/src/components/Composer/CollapsedBar.tsx',
      'web/src/components/PromptPicker/index.tsx',
      'web/src/components/Lightbox/Content.tsx',
      'web/src/components/Sidebar/index.tsx',
      'web/src/components/PromptManager/index.tsx',
      'web/src/components/PromptManager/SettingsPanel.tsx',
      'web/src/components/TextModels/ProviderForm.tsx',
      'web/src/components/TextModels/TestReport.tsx',
    ];
    for (const path of [...partOwners, 'web/src/components/Batch/index.tsx']) {
      const source = read(path);
      expect(source, path).toContain('default="none" enter="part-enter" exit="part-exit"');
      expect(source, path).not.toMatch(/<ViewTransition[^>]*\bname=/);
    }
    // The listed owners are the only captures; React alone starts transitions
    // and names boundaries.
    const owners = ['web/src/App.tsx', 'web/src/components/Batch/index.tsx', 'web/src/components/Canvas/index.tsx', 'web/src/components/Archive/index.tsx', ...partOwners];
    for (const path of webSources()) {
      const source = read(path);
      expect(source, path).not.toContain('startViewTransition');
      expect(source, path).not.toContain('viewTransitionName');
      if (!owners.includes(path)) expect(source, path).not.toMatch(/<ViewTransition\b/);
    }
  });

  test('tile exits have no hand-rolled timing left (ViewTransition owns them)', () => {
    const retired = /startLeaving|tileLeaving|cancel-out|pendingCancelRef|data-canceling/;
    for (const path of [...webSources(), ...webStylesheets()]) {
      expect(read(path), path).not.toMatch(retired);
    }
  });

  test('no subtitles: headings stand alone, with no small-caps or muted line beside them', () => {
    for (const path of webStylesheets()) {
      const found = [...read(path).matchAll(/\.(?:subtitle|paneTitle|kicker|version|backLink)\b/g)].map((match) => match[0]);
      const subtitles = path === 'web/src/components/PromptManager/index.module.css'
        ? found.filter((name) => name !== '.kicker')
        : found;
      expect({ path, subtitles }).toEqual({ path, subtitles: [] });
    }
    // The PromptManager kicker is the visible label of the inline name field.
    const kickerUsers = webSources().filter((path) => /\bstyles\.kicker\b/.test(read(path)));
    expect(kickerUsers).toEqual(['web/src/components/PromptManager/InlineFieldChrome.tsx']);
    expect(read('web/src/components/ManagedViewHeader/index.tsx')).not.toMatch(/\blabel\??:/);
    const picker = read('web/src/components/PromptPicker/index.tsx');
    const header = picker.slice(picker.indexOf('data-zone="head"'), picker.indexOf('aria-label="Close templates"'));
    expect(header.length).toBeGreaterThan(0);
    expect(header).not.toMatch(/<p[\s>]/);
  });

  test('radius reads only the role tokens; the legacy alias names are gone', () => {
    // --radius-3/4/7/lg/14 and the bare --radius; the role names
    // (--radius-control/-tile/-panel/-sheet) must not match.
    const legacy = /--radius(?:-(?:3|4|7|lg|14))?(?![\w-])/;
    for (const path of [...webStylesheets(), 'docs/handoff/design/app.js', 'docs/handoff/design/index.html']) {
      expect({ path, legacy: legacy.exec(read(path))?.[0] ?? null }).toEqual({ path, legacy: null });
    }
  });
  test('looping animations run on the --cadence-* tokens, never a literal duration', () => {
    for (const path of webStylesheets()) {
      const loops = motionDeclarations(read(path))
        .filter((decl) => /^animation(?:-duration)?\s*:/.test(decl) && /\binfinite\b/.test(decl))
        .filter((decl) => !decl.includes('var(--cadence-'));
      expect({ path, loops }).toEqual({ path, loops: [] });
    }
  });

  test('motion declarations carry no literal blur or scale amplitude', () => {
    // Only @keyframes bodies and animation*/transition* declarations are
    // inspected: backdrop-filter, a resting filter, --glass-blur and @supports
    // probes are not motion. The LoadingTile preview ladder (blur 16/12/8/4/2px,
    // overscan scale(1.06)) is a deliberate exception.
    const allowlist = new Map([['web/src/components/tile/LoadingTile/index.module.css', ['scale(1.06)']]]);
    const literal = /blur\(\d+(?:\.\d+)?px\)|scale\((?:0|1)\.\d+\)/g;
    for (const path of webStylesheets()) {
      const allowed = allowlist.get(path) ?? [];
      const css = read(path);
      const found = [...keyframeBodies(css), ...motionDeclarations(css)]
        .flatMap((text) => [...text.matchAll(literal)].map((match) => match[0]))
        .filter((hit) => !allowed.includes(hit));
      expect({ path, found }).toEqual({ path, found: [] });
    }
  });

  test('reduced motion stops view-transition geometry and leaves loop cadences to their owners', () => {
    const motion = read('web/src/styles/motion.css');
    const reduced = motion.slice(motion.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/::view-transition-group\(\*\) \{\s*animation: none;\s*\}/);
    expect(stripCssComments(reduced)).not.toContain('--cadence-');
    const tokens = read('web/src/styles/tokens.css');
    expect(tokens).toContain('--cadence-loop: 1600ms;');
    expect(tokens).toContain('--cadence-loop-fast: 700ms;');
  });
  test('press transitions live on the resting rule, so a release eases back', () => {
    const offenders = webStylesheets().flatMap((path) => cssBlocks(stripCssComments(read(path)))
      .filter((block) => /:active[^{]*\{/.test(block))
      .filter((block) => /(?:^|[;{\s])transition(?:-[a-z-]+)?\s*:/.test(block.slice(block.lastIndexOf('{'))))
      .map((block) => `${path}: ${block.slice(0, block.lastIndexOf('{')).trim().split('\n').at(-1) ?? ''}`));
    expect(offenders).toEqual([]);
  });

  test('picker and roll-queue close and remove controls compose the shared icon action', () => {
    const queue = read('web/src/components/RollQueueList/index.module.css');
    expect(queue).toMatch(/\.remove \{\s*composes: iconAction from '[^']*buttons\.module\.css';/);
    const picker = read('web/src/components/PromptPicker/index.module.css');
    expect(picker).toMatch(/\.menuClose \{\s*composes: iconAction from '[^']*buttons\.module\.css';/);
  });

  test('scroll-edge fades: the :root token or the scroller-local gradient on the registered stop', () => {
    // Custom properties resolve before inheritance, so a stop that varies per
    // scroller must sit in a gradient declared on the scroller itself.
    expect(read('web/src/styles/global.css')).toMatch(/@property --scroll-fade-top \{\s*syntax: '<length>';\s*inherits: false;\s*initial-value: 14px;\s*\}/);
    expect(read('web/src/styles/motion.css')).toMatch(/@keyframes atelier-scroll-edge \{\s*from \{ --scroll-fade-top: 0px; \}\s*to \{ --scroll-fade-top: 14px; \}\s*\}/);
    const local = 'mask-image: linear-gradient(to bottom, transparent 0, black var(--scroll-fade-top), black calc(100% - 14px), transparent 100%);';
    const offenders: string[] = [];
    for (const path of webStylesheets()) {
      const css = stripCssComments(read(path));
      for (const match of css.matchAll(/(?:^|[\s;{])(?:-webkit-)?mask-image\s*:\s*([^;}]*)/g)) {
        const value = (match[1] ?? '').trim();
        // Vertical scroll fades only; the horizontal tab-strip fade is its own rule.
        if (!value.includes('linear-gradient(to bottom')) continue;
        if (value === 'var(--scroll-fade-mask)') continue;
        if (`mask-image: ${value};` === local) continue;
        offenders.push(`${path}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const [path, selector] of [
      ['web/src/components/Sidebar/index.module.css', '.list'],
      ['web/src/components/Canvas/index.module.css', '.canvas'],
    ] as const) {
      const css = stripCssComments(read(path));
      const rule = cssBlocks(css).find((block) => block.trimStart().startsWith(`${selector} {`)) ?? '';
      expect(rule).toContain('--scroll-fade-top: 14px;');
      expect(rule).toContain(local);
      const supports = css.slice(css.indexOf('@supports (animation-timeline: scroll())'));
      expect(supports).toMatch(new RegExp(`\\${selector} \\{\\s*animation: global\\(atelier-scroll-edge\\) linear both;\\s*animation-timeline: scroll\\(self block\\);\\s*animation-range: 0 28px;`));
    }
  });

  test('every member of the shared disabled dim transitions opacity, so its entry delay holds', () => {
    // transition-delay only delays properties in the element's own transition
    // list; a member without opacity there would dim instantly on every
    // navigation's read-only blip.
    const css = read('web/src/styles/buttons.module.css');
    for (const selector of ['.iconAction', '.tileAction']) {
      const base = new RegExp(`(^|\\n)(?:[^{}\\n]*,\\s*\\n)*\\${selector}(?:,\\s*\\n[^{}\\n]*)*\\s*\\{([^}]*)\\}`).exec(css);
      expect(base, `${selector} base rule`).not.toBeNull();
      expect(base?.[2] ?? '', `${selector} transition list`).toMatch(/transition:[^;]*\bopacity\b/);
    }
  });

  test('surface.module.css declares its resting pose only at zero specificity', () => {
    // Every module composing the surface carries its own copy; a resting
    // opacity or transform on a class selector would let a later copy reset
    // an owner's resting pose on the same element.
    const css = stripCssComments(read('web/src/styles/surface.module.css'));
    const offenders: string[] = [];
    for (const match of css.matchAll(/(^|\})\s*([^{}@]+)\{([^{}]*?)(?=\}|@starting-style)/g)) {
      const head = (match[2] ?? '').trim();
      const body = match[3] ?? '';
      if (head.startsWith(':where(') || head.includes('[data-closing')) continue;
      if (/(?:^|[\s;])(?:opacity|transform)\s*:/.test(body)) offenders.push(head);
    }
    expect(offenders).toEqual([]);
    expect(css).toMatch(/:where\(\.surface\) \{\s*opacity: 1;\s*transform: none;\s*\}/);
  });
});
