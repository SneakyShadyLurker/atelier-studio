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

  test('mono font declarations use tabular numerals', () => {
    const paths = [
      'web/src/App.module.css',
      'web/src/styles/dialog.module.css',
      'web/src/styles/global.css',
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

  test('content-column inset is tokenized so portaled overlays centre over the composer', () => {
    expect(read('docs/handoff/design/index.html')).toContain('--sidebar-width: 240px;');
    expect(read('web/src/styles/tokens.css')).toContain('--sidebar-width: 240px;');
    expect(read('web/src/App.module.css')).toContain('grid-template-columns: var(--sidebar-width) 1fr;');
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
    expect(read('web/src/components/Composer/EnhanceControl.tsx')).toContain('<I.reroll />');
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
      expect(css).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.(?:06|08|1|10|12|15|34|35|65|7|85|9)\)/);
      expect(css).not.toContain('0 40px 100px -20px rgba(0,0,0,0.5)');
    }
  });

  test('element-anchored overlays are placed by native CSS anchors, not script geometry', () => {
    const geometry = /getBoundingClientRect|getClientRects|offset(Width|Height|Top|Left)|inner(Width|Height)|scroll(X|Y)|-9999|useAnchoredPosition/;
    // Top-layer owners take their implicit anchor from showPopover({ source }).
    for (const path of [
      'web/src/components/BatchOverflowMenu/index.tsx',
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
});
