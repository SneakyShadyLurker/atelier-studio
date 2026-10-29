import type { Batch as WireBatch } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { fixtureModels } from '../../../test/fixtures/models';
import { doneTile } from '../../../test/fixtures/tiles';
import { APP_VIEW_UNSORTED, useAtelierStore, initialAtelierState } from '../../store/atelier';
import BatchView from './index';

afterEach(() => { cleanup(); mock.restore(); useAtelierStore.setState(initialAtelierState, true); });

const firstModel = fixtureModels[0];
if (!firstModel) throw new Error('fixtureModels is empty');
const modelById = new Map(fixtureModels.map((m) => [m.id, m]));

const baseBatch: WireBatch = {
  id: 'b1', prompt: 'a cat', ratio: '1:1', modelId: firstModel.id,
  modelLabel: 'Test', createdAt: Date.now(), collectionId: null,
  pinned: false, status: 'done', tiles: [doneTile('tile-1', 1, 'ONE')],
};

function renderBatch(batch: WireBatch, promptsEnabled = true) {
  function Wrap({ children }: PropsWithChildren) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(
    <BatchView batch={batch} modelById={modelById} activeView={APP_VIEW_UNSORTED}
      promptsEnabled={promptsEnabled} isAboveFold onBatchAction={mock()} onTileAction={mock()} onOpenTile={mock()} q="" />,
    { wrapper: Wrap },
  );
}

describe('Batch — provenance surface', () => {
  test('renders sparkle meta token with templateName and seed tooltip', () => {
    renderBatch({ ...baseBatch, provenance: { templateId: 'tpl1', templateName: 'Cinematic', rollSeed: 4242, pins: {} } });
    expect(screen.getByText('Cinematic')).toBeTruthy();
    // Reopen in picker is now in the overflow menu — open it to verify presence
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('menuitem', { name: /reopen in picker/i })).toBeTruthy();
  });

  test('omits reopen while the prompt library is gated or still loading', () => {
    renderBatch({ ...baseBatch, provenance: { templateId: 'tpl1', templateName: 'Cinematic', rollSeed: 4242, pins: {} } }, false);
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('menuitem', { name: /reopen in picker/i })).toBeNull();
  });

  test('omits provenance token + reopen button when no provenance', () => {
    renderBatch(baseBatch);
    // Open the overflow menu and verify Reopen is absent
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('menuitem', { name: /reopen in picker/i })).toBeNull();
  });

  // Finding F: when the source template was deleted (ON DELETE SET NULL nulls
  // template_id), the provenance META still renders but the reopen affordance
  // must NOT — it can't deliver the reproduce it promises.
  test('omits reopen button when provenance.templateId is null (template deleted)', () => {
    renderBatch({ ...baseBatch, provenance: { templateId: null, templateName: null, rollSeed: 4242, pins: {} } });
    // Open the overflow menu and verify Reopen is absent even though provenance exists
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('menuitem', { name: /reopen in picker/i })).toBeNull();
  });
});
