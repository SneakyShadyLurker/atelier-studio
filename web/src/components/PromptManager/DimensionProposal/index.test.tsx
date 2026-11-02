import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DimensionChangeBundle, InferDimensionsResponse, TemplateConflict } from '@atelier/shared';
import DimensionProposal from './index';

function makeQc(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithQc(ui: ReactElement, qc: QueryClient = makeQc()) {
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

// Defaults the diagnose endpoint to echo back the provided conflicts —
// "user hasn't changed selection yet, so live diagnose agrees with the
// infer-time snapshot". Test-local overrides for reactive scenarios.
function defaultDiagnoseEcho(data: InferDimensionsResponse) {
  return (_body: { proposalId: string; acceptedBundleKeys: string[] }) =>
    jsonResponse({ conflicts: data.conflicts });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Route fetch by URL path: diagnose calls go to one handler, rescue calls
// to another. Tests that don't care about diagnose still need it to
// resolve (empty conflicts) — otherwise the useQuery sits in pending
// state and the apply path's onApply runs while diagnose is in-flight,
// which is a valid scenario but not what most tests are testing.
function routeFetch(handlers: {
  diagnose?: (body: { proposalId: string; acceptedBundleKeys: string[] }) => Response | Promise<Response>;
  rescue?: () => Response | Promise<Response>;
}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.includes('/prompts/dimensions/diagnose-selection')) {
      const body = init?.body ? JSON.parse(init.body as string) as { proposalId: string; acceptedBundleKeys: string[] } : { proposalId: '', acceptedBundleKeys: [] };
      const handler = handlers.diagnose ?? (() => jsonResponse({ conflicts: [] }));
      return Promise.resolve(handler(body));
    }
    if (url.includes('/prompts/dimensions/rescue')) {
      const handler = handlers.rescue ?? (() => new Response(':keepalive\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      return Promise.resolve(handler());
    }
    throw new Error(`Unrouted fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}

const noop = () => {
  return 'noop';
};

const baseData: InferDimensionsResponse = {
  proposalId: 'p',
  baseSnapshotHash: 'h',
  rejected: [{ reason: 'stale', count: 2 }],
  warnings: [{ templateName: 'Scene', detail: 'no coherent combination across: A, B' }],
  coverage: [],
  conflicts: [],
  proposal: {
    bundles: [
      {
        key: 'create:F',
        kind: 'create',
        title: 'New dimension: F',
        dimensionName: 'F',
        detail: 'tags 3 options across 1 list',
        impact: '',
        destructive: false,
        defaultChecked: true,
        dependsOn: [],
        optionCount: 3,
        listCount: 1,
      },
      {
        key: 'merge:d2',
        kind: 'merge',
        title: 'Merge: F',
        dimensionName: 'F',
        detail: '',
        impact: 'merge IP into F -- 2 options become multi-tagged (wildcard risk)',
        destructive: true,
        defaultChecked: true,
        dependsOn: ['create:F'],
        optionCount: 0,
        listCount: 0,
      },
    ],
  },
};

const origFetch = globalThis.fetch;

function withConflicts(conflicts: readonly TemplateConflict[]): InferDimensionsResponse {
  return { ...baseData, conflicts };
}

function rescueSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function calloutFor(templateName: string): HTMLElement {
  // Match by raw attribute value so test helpers tolerate the same
  // metacharacter-rich templateNames the Fix 5 scrollToConflict tolerates.
  const candidates = document.querySelectorAll<HTMLElement>('[data-conflict]');
  for (const el of candidates) {
    if (el.getAttribute('data-conflict') === templateName) return el;
  }
  throw new Error(`No callout for ${templateName}`);
}

function findBtn(scope: HTMLElement, label: RegExp): HTMLButtonElement {
  const btn = Array.from(scope.querySelectorAll('button')).find(
    (b) => label.test(b.textContent),
  );
  if (!btn) throw new Error(`No button matching ${label.source}`);
  return btn;
}

function queryBtn(scope: HTMLElement, label: RegExp): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll('button')).find(
    (b) => label.test(b.textContent),
  );
}

function getInputByLabel(labelText: RegExp): HTMLInputElement {
  const el = screen.getByLabelText(labelText);
  if (!(el instanceof HTMLInputElement)) throw new Error('expected HTMLInputElement');
  return el;
}

describe('DimensionProposal — bundle pick + apply', () => {
  beforeEach(() => {
    // Default diagnose: never resolve. Lets tests that don't care about
    // the live-recheck assert on the infer-time `data.conflicts` snapshot
    // without the backgrounded useQuery clearing it (an empty conflicts
    // response IS the correct production behaviour — the user's full
    // selection has no conflict — but tests asserting the initial
    // render shouldn't have to model that).
    globalThis.fetch = routeFetch({ diagnose: () => new Promise<Response>(() => { /* stalls forever */ }) });
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.fetch = origFetch;
  });

  test('reconcile bundle checked by default; counts in Apply label; skipped + warning shown', () => {
    renderWithQc(<DimensionProposal data={baseData} onApply={noop} onCancel={noop} busy={false} />);
    expect(screen.getByRole('button', { name: /Apply 2 of 2/ })).toBeTruthy();
    expect(screen.getByText(/wildcard risk/)).toBeTruthy();
    expect(screen.getByText(/no coherent combination/)).toBeTruthy();
    expect(screen.getByText(/skipped/i)).toBeTruthy();
  });

  test('shows a Re-checking… status and marks Apply aria-busy while a SAT recheck is in flight', async () => {
    renderWithQc(<DimensionProposal data={baseData} onApply={noop} onCancel={noop} busy={false} />);
    await waitFor(() => { expect(screen.getByText('Re-checking…')).toBeTruthy(); });
    expect(screen.getByRole('button', { name: /Apply 2 of 2/ }).getAttribute('aria-busy')).toBe('true');
  });

  test('unchecking a depended-upon bundle force-disables the dependent and recounts', () => {
    renderWithQc(<DimensionProposal data={baseData} onApply={noop} onCancel={noop} busy={false} />);
    fireEvent.click(screen.getByLabelText(/New dimension: F/));
    expect(screen.getByRole('button', { name: /Apply 0 of 2/ })).toBeTruthy();
  });

  test('primary apply sends empty acceptUnsatisfiableTemplates when no opt-in', () => {
    const onApply = mock(() => 'applied');
    renderWithQc(<DimensionProposal data={baseData} onApply={onApply} onCancel={noop} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Apply 2 of 2/ }));
    expect(onApply).toHaveBeenCalledWith(['create:F', 'merge:d2'], []);
  });
});

// The server preserves original operation order, so "rename A->X, merge B
// into A, rename A->Y" yields a real rename:dA <-> merge:dB cycle. The UI
// must treat the pair as one selection unit instead of deadlocking it.
function reconcileBundle(
  key: string,
  kind: 'merge' | 'rename',
  dimensionName: string,
  dependsOn: string[],
  defaultChecked = true,
): DimensionChangeBundle {
  return {
    key,
    kind,
    title: `${kind === 'merge' ? 'Merge' : 'Rename'}: ${dimensionName}`,
    dimensionName,
    detail: '',
    impact: '',
    destructive: kind === 'merge',
    defaultChecked,
    dependsOn,
    optionCount: 0,
    listCount: 0,
  };
}

function proposalWith(
  bundles: DimensionChangeBundle[],
  conflicts: readonly TemplateConflict[] = [],
): InferDimensionsResponse {
  return { ...baseData, warnings: [], rejected: [], conflicts, proposal: { bundles } };
}

const createF = baseData.proposal.bundles[0];
if (!createF) throw new Error('expected the creation fixture bundle');
const renameA = reconcileBundle('rename:dA', 'rename', 'A', ['merge:dB']);
const mergeB = reconcileBundle('merge:dB', 'merge', 'B', ['rename:dA']);

function cycleInputs(): HTMLInputElement[] {
  return [getInputByLabel(/Rename: A/), getInputByLabel(/Merge: B/)];
}

function appliedKeys(onApply: { mock: { calls: unknown[][] } }): string[] {
  const call = onApply.mock.calls[0] as unknown as [string[], string[]];
  return [...call[0]].sort();
}

describe('DimensionProposal — cyclic bundle dependencies', () => {
  beforeEach(() => {
    globalThis.fetch = routeFetch({ diagnose: () => new Promise<Response>(() => { /* stalls forever */ }) });
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.fetch = origFetch;
  });

  for (const [deselect, reselect] of [[/Rename: A/, /Merge: B/], [/Merge: B/, /Rename: A/]] as const) {
    test(`deselecting ${deselect.source} and reselecting ${reselect.source} moves the whole cycle`, () => {
      const onApply = mock(() => 'applied');
      renderWithQc(<DimensionProposal data={proposalWith([renameA, mergeB])} onApply={onApply} onCancel={noop} busy={false} />);
      expect(screen.getByRole('button', { name: /^Apply 2 of 2$/ })).toBeTruthy();

      fireEvent.click(getInputByLabel(deselect));
      for (const input of cycleInputs()) {
        expect(input.checked).toBe(false);
        // Pre-fix both rows were disabled here, a permanent deadlock.
        expect(input.disabled).toBe(false);
      }
      expect(screen.getByRole('button', { name: /^Apply 0 of 2$/ })).toBeTruthy();

      fireEvent.click(getInputByLabel(reselect));
      for (const input of cycleInputs()) expect(input.checked).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: /^Apply 2 of 2$/ }));
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(appliedKeys(onApply)).toEqual(['merge:dB', 'rename:dA']);
    });
  }

  test('busy keeps cycle members disabled', () => {
    renderWithQc(<DimensionProposal data={proposalWith([renameA, mergeB])} onApply={noop} onCancel={noop} busy />);
    for (const input of cycleInputs()) expect(input.disabled).toBe(true);
  });

  test('a partially default-checked cycle starts unchecked and is selectable as a unit', () => {
    const data = proposalWith([renameA, reconcileBundle('merge:dB', 'merge', 'B', ['rename:dA'], false)]);
    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    for (const input of cycleInputs()) {
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(false);
    }
    expect(screen.getByRole('button', { name: /^Apply 0 of 2$/ })).toBeTruthy();

    fireEvent.click(getInputByLabel(/Merge: B/));
    for (const input of cycleInputs()) expect(input.checked).toBe(true);
    expect(screen.getByRole('button', { name: /^Apply 2 of 2$/ })).toBeTruthy();
  });

  test('an external dependency still gates the whole cycle and restores it when re-checked', () => {
    const onApply = mock(() => 'applied');
    const data = proposalWith([
      createF,
      reconcileBundle('rename:dA', 'rename', 'A', ['merge:dB', 'create:F']),
      mergeB,
    ]);
    renderWithQc(<DimensionProposal data={data} onApply={onApply} onCancel={noop} busy={false} />);
    expect(screen.getByRole('button', { name: /^Apply 3 of 3$/ })).toBeTruthy();

    // Only rename depends on create:F directly, but merge cannot apply
    // without rename, so both rows are gated.
    fireEvent.click(getInputByLabel(/New dimension: F/));
    for (const input of cycleInputs()) {
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(true);
    }
    expect(screen.getByRole('button', { name: /^Apply 0 of 3$/ })).toBeTruthy();

    // Re-checking the dependency restores the dependent cycle, matching the
    // acyclic dependent-restoration behaviour.
    fireEvent.click(getInputByLabel(/New dimension: F/));
    for (const input of cycleInputs()) {
      expect(input.checked).toBe(true);
      expect(input.disabled).toBe(false);
    }

    fireEvent.click(getInputByLabel(/Merge: B/));
    expect(getInputByLabel(/New dimension: F/).checked).toBe(true);
    for (const input of cycleInputs()) expect(input.checked).toBe(false);
    expect(screen.getByRole('button', { name: /^Apply 1 of 3$/ })).toBeTruthy();

    fireEvent.click(getInputByLabel(/Rename: A/));
    fireEvent.click(screen.getByRole('button', { name: /^Apply 3 of 3$/ }));
    expect(appliedKeys(onApply)).toEqual(['create:F', 'merge:dB', 'rename:dA']);
  });

  test('a dependency key missing from the proposal keeps the cycle blocked', () => {
    const data = proposalWith([renameA, reconcileBundle('merge:dB', 'merge', 'B', ['rename:dA', 'extend:gone'])]);
    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    for (const input of cycleInputs()) {
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(true);
    }
    expect(screen.getByRole('button', { name: /^Apply 0 of 2$/ })).toBeTruthy();
  });

  test('conflict Skip drops the whole cycle; manual re-check and Undo both restore it', () => {
    const onApply = mock(() => 'applied');
    const data = proposalWith([renameA, mergeB], [
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['merge:dB'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    renderWithQc(<DimensionProposal data={data} onApply={onApply} onCancel={noop} busy={false} />);

    fireEvent.click(findBtn(calloutFor('Portrait'), /Skip/i));
    for (const input of cycleInputs()) {
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(false);
    }

    // Recoverable from the checkbox while skipped.
    fireEvent.click(getInputByLabel(/Rename: A/));
    for (const input of cycleInputs()) expect(input.checked).toBe(true);
    fireEvent.click(getInputByLabel(/Rename: A/));
    for (const input of cycleInputs()) expect(input.checked).toBe(false);

    // Undo re-checks the culprit's whole group, not just merge:dB.
    fireEvent.click(findBtn(calloutFor('Portrait'), /Undo/i));
    for (const input of cycleInputs()) expect(input.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /^Apply 2 of 2$/ }));
    expect(appliedKeys(onApply)).toEqual(['merge:dB', 'rename:dA']);
  });
});

describe('DimensionProposal — per-template conflict UI', () => {
  beforeEach(() => {
    // Default diagnose: never resolve — lets the initial render assert
    // on data.conflicts without the live-recheck clearing them. Reactive
    // tests override via routeFetch({ diagnose: ..., rescue: ... }).
    globalThis.fetch = routeFetch({ diagnose: () => new Promise<Response>(() => { /* stalls forever */ }) });
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.fetch = origFetch;
  });

  test('renders one conflict callout per TemplateConflict', () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options for outfit', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
      { templateName: 'Scene', reason: 'no options for venue', culpritBundleKeys: ['merge:d2'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    expect(document.querySelectorAll('[data-conflict]').length).toBe(2);
    expect(document.querySelector('[data-conflict="Portrait"]')).toBeTruthy();
    expect(document.querySelector('[data-conflict="Scene"]')).toBeTruthy();
  });

  test('non-local conflict disables Skip with accessible explanatory text and no native title', () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'multi-list interaction', culpritBundleKeys: [], rescueAttempted: false, culpritKind: 'non-local' },
    ]);
    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    const skipBtn = findBtn(calloutFor('Portrait'), /Skip/i);
    expect(skipBtn.disabled).toBe(true);
    expect(skipBtn.getAttribute('title')).toBeNull();
    expect(skipBtn.getAttribute('data-tip')).toContain("can't identify a single bundle");
    const describedBy = skipBtn.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain("can't identify a single bundle");
  });

  test('Skip unchecks culprits; Undo re-checks them; Rescue then preserves them', async () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    const rescueBundle = {
      key: 'rescue:Portrait',
      kind: 'rescue' as const,
      title: 'Rescue: Portrait',
      detail: 'adds X to Y',
      impact: '',
      destructive: false,
      defaultChecked: true,
      dependsOn: ['create:F'],
      listName: 'outfit',
      optionValue: 'vintage jacket',
      templateName: 'Portrait',
    };
    globalThis.fetch = routeFetch({
      diagnose: defaultDiagnoseEcho(data),
      rescue: () => rescueSseResponse(
        `event: done\ndata: ${JSON.stringify({ rescueBundle, conflicts: [{ ...data.conflicts[0], rescueAttempted: true }] })}\n\n`,
      ),
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);

    expect(getInputByLabel(/New dimension: F/).checked).toBe(true);

    // Skip → culprit unchecks.
    fireEvent.click(findBtn(calloutFor('Portrait'), /Skip/i));
    expect(getInputByLabel(/New dimension: F/).checked).toBe(false);

    // Undo → culprit re-checks (the intent for skipped→unresolved transition).
    fireEvent.click(findBtn(calloutFor('Portrait'), /Undo/i));
    expect(getInputByLabel(/New dimension: F/).checked).toBe(true);

    // Rescue from unresolved state — culprits stay checked AND the rescue bundle appears.
    fireEvent.click(findBtn(calloutFor('Portrait'), /Rescue with AI/i));

    await waitFor(() => {
      expect(document.querySelector('[data-bundle-kind="rescue"]')).toBeTruthy();
    });
    expect(getInputByLabel(/New dimension: F/).checked).toBe(true);
  });

  test('Apply anyway adds templateName to acceptUnsatisfiableTemplates', () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    const onApply = mock(() => 'applied');
    renderWithQc(<DimensionProposal data={data} onApply={onApply} onCancel={noop} busy={false} />);
    fireEvent.click(findBtn(calloutFor('Portrait'), /Apply anyway/i));
    fireEvent.click(screen.getByRole('button', { name: /^Apply 2 of 2$/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const lastCall = onApply.mock.calls[0] as unknown as [string[], string[]];
    expect(lastCall[0]).toContain('create:F');
    expect(lastCall[1]).toEqual(['Portrait']);
  });

  test('rescue success appears as a new bundle row', async () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    const rescueBundle = {
      key: 'rescue:Portrait',
      kind: 'rescue' as const,
      title: 'Rescue: Portrait',
      detail: '',
      impact: '',
      destructive: false,
      defaultChecked: true,
      dependsOn: ['create:F'],
      listName: 'outfit',
      optionValue: 'vintage jacket',
      templateName: 'Portrait',
    };
    globalThis.fetch = routeFetch({
      diagnose: defaultDiagnoseEcho(data),
      rescue: () => rescueSseResponse(
        `event: done\ndata: ${JSON.stringify({ rescueBundle, conflicts: [{ ...data.conflicts[0], rescueAttempted: true }] })}\n\n`,
      ),
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    fireEvent.click(findBtn(calloutFor('Portrait'), /Rescue with AI/i));

    await waitFor(() => {
      expect(document.querySelector('[data-bundle-kind="rescue"]')).toBeTruthy();
    });
    expect(screen.getByText(/AI added "vintage jacket" to outfit/)).toBeTruthy();
  });

  test('rescue failure shows cap-spent state with rescue disabled', async () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    // Server-side Fix 3: rescue-failed payload carries updated conflicts
    // with rescueAttempted=true so the client enforces cap-spent without
    // a parallel rescue-failed-reason store.
    const updatedConflicts = [{ ...data.conflicts[0], rescueAttempted: true }];
    globalThis.fetch = routeFetch({
      diagnose: defaultDiagnoseEcho(data),
      rescue: () => rescueSseResponse(
        `event: rescue-failed\ndata: ${JSON.stringify({ reason: 'option-already-exists', conflicts: updatedConflicts })}\n\n`,
      ),
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    fireEvent.click(findBtn(calloutFor('Portrait'), /Rescue with AI/i));

    await waitFor(() => {
      const text = calloutFor('Portrait').textContent;
      expect(text.includes('Rescue failed: option-already-exists')).toBe(true);
    });
    // Rescue button should no longer be rendered (cap spent — only Skip + Apply anyway remain).
    expect(queryBtn(calloutFor('Portrait'), /Rescue with AI/i)).toBeFalsy();
  });

  test('Fix 5: scrollToConflict tolerates template names with selector metacharacters', () => {
    const data = withConflicts([
      { templateName: 'a"b', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    const badge = queryBtn(document.body, /Conflicts with "a"b"/);
    expect(badge).toBeTruthy();
    if (!badge) throw new Error('unreachable');
    // Interpolating the raw templateName into an attribute selector
    // would throw DOMException at querySelector time. Just clicking is
    // the regression test — if scrollToConflict throws, the test fails.
    expect(() => { fireEvent.click(badge); }).not.toThrow();
  });

  test('Fix 3 client: rescue-failed propagates conflicts so culprit badge reflects rescueAttempted', async () => {
    // The server-side Fix 3 sends updated conflicts on rescue-failed
    // (rescueAttempted=true on the matching entry). The client must
    // overwrite local conflicts state so any downstream consumer that
    // reads `conflict.rescueAttempted` sees the spent-cap flag — this
    // matters whenever a rescue-failed state later transitions back to
    // unresolved (the `rescueDisabled` derivation in ConflictCallout
    // ORs in `conflict.rescueAttempted`).
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    const updatedConflicts = [{ ...data.conflicts[0], rescueAttempted: true }];
    globalThis.fetch = routeFetch({
      diagnose: defaultDiagnoseEcho(data),
      rescue: () => rescueSseResponse(
        `event: rescue-failed\ndata: ${JSON.stringify({ reason: 'option-already-exists', conflicts: updatedConflicts })}\n\n`,
      ),
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    fireEvent.click(findBtn(calloutFor('Portrait'), /Rescue with AI/i));

    await waitFor(() => {
      const text = calloutFor('Portrait').textContent;
      expect(text.includes('Rescue failed')).toBe(true);
    });
    // Conflicts state propagated — the culprit badge still references
    // the conflict (which now has rescueAttempted=true). The render-time
    // proof that conflicts were updated is that the rescue-failed branch
    // is shown (no Rescue button) AND the badge for the conflict is
    // still rendered (conflict is still present in local conflicts state
    // with updated flag, not stale).
    expect(queryBtn(calloutFor('Portrait'), /Rescue with AI/i)).toBeFalsy();
    const badge = queryBtn(document.body, /Conflicts with "Portrait"/);
    expect(badge).toBeTruthy();
  });

  test('Fix 2: rescue-in-flight on one template disables Rescue on the other', async () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
      { templateName: 'Scene', reason: 'no options', culpritBundleKeys: ['merge:d2'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    // Stalling fetch — never resolves while we inspect the UI mid-flight.
    let releasePortrait!: () => void;
    const stall = new Promise<Response>((resolve) => {
      releasePortrait = () => {
        resolve(rescueSseResponse(':keepalive\n\n'));
      };
    });
    globalThis.fetch = routeFetch({
      diagnose: defaultDiagnoseEcho(data),
      rescue: () => stall,
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    fireEvent.click(findBtn(calloutFor('Portrait'), /Rescue with AI/i));

    await waitFor(() => {
      expect(findBtn(calloutFor('Portrait'), /Rescuing/i)).toBeTruthy();
    });
    // The other template's Rescue button is disabled while Portrait is in flight.
    const sceneRescue = findBtn(calloutFor('Scene'), /Rescue with AI/i);
    expect(sceneRescue.disabled).toBe(true);

    // Release the stalled fetch and let the resulting state update flush
    // before the test exits — otherwise the rescue-failed transition (no
    // terminal event → stream-ended-without-terminal-event throw → catch
    // block setStateFor) updates state outside of an act() scope.
    await act(async () => {
      releasePortrait();
      // One microtask is enough for the resolved fetch to flow through
      // the readSseFrames async-iterator, throw, and reach the catch.
      await new Promise<void>((r) => { setTimeout(r, 0); });
    });
  });

  test('M3: Remove rescue auto-Skips culprits and transitions to skipped (avoids 422 dead-end)', async () => {
    // After a successful rescue, the user clicks "Remove rescue".
    // Pre-M3 behaviour: state goes to unresolved while culprits stay picked
    // → Apply 422s because the template is still unsatisfiable, no recovery
    // affordance. M3 fix: treat Remove rescue as auto-Skip — culprits unpick,
    // state transitions to skipped (the collapsed callout + Undo path).
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    const rescueBundle = {
      key: 'rescue:Portrait',
      kind: 'rescue' as const,
      title: 'Rescue: Portrait',
      detail: '',
      impact: '',
      destructive: false,
      defaultChecked: true,
      dependsOn: ['create:F'],
      listName: 'outfit',
      optionValue: 'vintage jacket',
      templateName: 'Portrait',
    };
    globalThis.fetch = routeFetch({
      diagnose: defaultDiagnoseEcho(data),
      rescue: () => rescueSseResponse(
        `event: done\ndata: ${JSON.stringify({ rescueBundle, conflicts: [{ ...data.conflicts[0], rescueAttempted: true }] })}\n\n`,
      ),
    });

    const onApply = mock(() => 'applied');
    renderWithQc(<DimensionProposal data={data} onApply={onApply} onCancel={noop} busy={false} />);

    // Rescue first.
    fireEvent.click(findBtn(calloutFor('Portrait'), /Rescue with AI/i));
    await waitFor(() => {
      expect(document.querySelector('[data-bundle-kind="rescue"]')).toBeTruthy();
    });

    // Click Remove rescue.
    fireEvent.click(findBtn(calloutFor('Portrait'), /Remove rescue/i));

    // Culprit bundle is now unchecked (auto-Skip).
    expect(getInputByLabel(/New dimension: F/).checked).toBe(false);
    // Callout shows the collapsed Skipped state with Undo.
    expect(calloutFor('Portrait').textContent).toContain('Skipped');
    expect(queryBtn(calloutFor('Portrait'), /Undo/i)).toBeTruthy();

    // Apply does NOT 422 — the culprit is no longer picked, so the apply
    // payload is satisfiable. Verified by asserting onApply was called and
    // the payload omits the culprit.
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ of \d+$/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const lastCall = onApply.mock.calls[0] as unknown as [string[], string[]];
    expect(lastCall[0]).not.toContain('create:F');
    // No opt-in either — auto-Skip means we don't accept the unsatisfiable
    // state, we drop the culprits entirely.
    expect(lastCall[1]).toEqual([]);
  });

  test('culprit bundle row gets a "Conflicts with" badge', () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    const badge = queryBtn(document.body, /Conflicts with "Portrait"/);
    expect(badge).toBeTruthy();
  });
});

describe('DimensionProposal — live diagnose-selection', () => {
  beforeEach(() => {
    globalThis.fetch = routeFetch({ diagnose: () => new Promise<Response>(() => { /* stalls forever */ }) });
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.fetch = origFetch;
  });

  test('live diagnose updates conflicts when user toggles a bundle', async () => {
    // Start clean (no infer-time conflicts), then have the diagnose
    // endpoint flip to "Portrait now conflicts" as soon as the user
    // unchecks `create:F`. The conflict callout must materialize from
    // the diagnose response (not from data.conflicts which was empty).
    const data: InferDimensionsResponse = baseData;
    const newConflict = {
      templateName: 'Portrait',
      reason: 'unchecking the dim broke Portrait',
      culpritBundleKeys: [] as string[],
      rescueAttempted: false,
      culpritKind: 'non-local' as const,
    };
    // First call (initial render with full picked set) → empty.
    // Subsequent calls (after toggle) → the new conflict.
    let callCount = 0;
    globalThis.fetch = routeFetch({
      diagnose: () => {
        callCount += 1;
        if (callCount === 1) return jsonResponse({ conflicts: [] });
        return jsonResponse({ conflicts: [newConflict] });
      },
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);

    // Initial render: no conflict callouts.
    await waitFor(() => { expect(callCount).toBeGreaterThanOrEqual(1); });
    expect(document.querySelectorAll('[data-conflict]').length).toBe(0);

    // Toggle `create:F` off — closure walk drops `merge:d2` too →
    // effective set shrinks → query refetches → server returns the
    // new conflict.
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/New dimension: F/));
      await new Promise<void>((resolve) => { setTimeout(resolve, 320); });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-conflict="Portrait"]')).toBeTruthy();
    });
  });

  test('live diagnose removes conflicts when user picks a non-breaking selection', async () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    // First call (full selection) → echo the infer-time conflict.
    // Subsequent calls (after the user unchecks the culprit bundle) →
    // empty (the selection no longer conflicts).
    let callCount = 0;
    globalThis.fetch = routeFetch({
      diagnose: () => {
        callCount += 1;
        if (callCount === 1) return jsonResponse({ conflicts: data.conflicts });
        return jsonResponse({ conflicts: [] });
      },
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);

    // Wait for the first diagnose pass (echo) to land — the callout
    // is present from data.conflicts before the first response and
    // is preserved through the echo reconciliation.
    await waitFor(() => { expect(callCount).toBeGreaterThanOrEqual(1); });
    expect(document.querySelector('[data-conflict="Portrait"]')).toBeTruthy();

    // Uncheck the culprit bundle (`create:F` is the only culprit) so
    // the diagnose query refetches and the server reports no conflict.
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/New dimension: F/));
      await new Promise<void>((resolve) => { setTimeout(resolve, 320); });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-conflict="Portrait"]')).toBeFalsy();
    });
    // 15s (default 5s): passes in isolation but trips the default under
    // parallel-workspace load in the root `bun run test` run.
  }, 15_000);

  test('diagnose retains previous conflicts via placeholderData while refetching', async () => {
    const data = withConflicts([
      { templateName: 'Portrait', reason: 'no options', culpritBundleKeys: ['create:F'], rescueAttempted: false, culpritKind: 'local' },
    ]);
    // First call resolves immediately with the echo. Second call
    // stalls — we want to assert the previous conflict is still visible
    // while the in-flight fetch is pending.
    let callCount = 0;
    let releaseSecond!: () => void;
    const secondStall = new Promise<Response>((resolve) => {
      releaseSecond = () => { resolve(jsonResponse({ conflicts: [] })); };
    });
    globalThis.fetch = routeFetch({
      diagnose: () => {
        callCount += 1;
        if (callCount === 1) return jsonResponse({ conflicts: data.conflicts });
        return secondStall;
      },
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    await waitFor(() => {
      expect(document.querySelector('[data-conflict="Portrait"]')).toBeTruthy();
    });

    // Toggle to trigger the stalled refetch.
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/New dimension: F/));
      await Promise.resolve();
    });

    // Wait for the second call to be issued.
    await waitFor(() => { expect(callCount).toBeGreaterThanOrEqual(2); });
    // While the second call is stalled, placeholderData keeps the
    // previously-rendered conflict visible (no flash to empty state).
    expect(document.querySelector('[data-conflict="Portrait"]')).toBeTruthy();

    // Release the stalled fetch and let the resolved state flush.
    await act(async () => {
      releaseSecond();
      await new Promise<void>((r) => { setTimeout(r, 0); });
    });
  });

  test('rapid bundle toggles debounce diagnose requests into one settled selection', async () => {
    const data: InferDimensionsResponse = { ...baseData, conflicts: [] };
    const acceptedSets: string[][] = [];
    globalThis.fetch = routeFetch({
      diagnose: (body) => {
        acceptedSets.push(body.acceptedBundleKeys);
        return jsonResponse({ conflicts: [] });
      },
    });

    renderWithQc(<DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />);
    await waitFor(() => { expect(acceptedSets).toHaveLength(1); });

    await act(async () => {
      fireEvent.click(screen.getByLabelText(/New dimension: F/));
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      fireEvent.click(screen.getByLabelText(/New dimension: F/));
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      fireEvent.click(screen.getByLabelText(/New dimension: F/));
      await new Promise<void>((resolve) => { setTimeout(resolve, 320); });
    });

    await waitFor(() => { expect(acceptedSets).toHaveLength(2); });
    expect(acceptedSets.at(-1)).toEqual([]);
  });

  test('apply-422 safety net still fires if diagnose race-loses to apply', () => {
    // Diagnose hasn't returned yet — user clicks Apply, the server
    // 422s, parent passes applyCoherenceFailures down. The inline
    // controls must still render (the 269403a safety net is preserved).
    const data: InferDimensionsResponse = { ...baseData, conflicts: [] };
    // Diagnose stalls so the live query never reports anything.
    globalThis.fetch = routeFetch({ diagnose: () => new Promise<Response>(() => { /* stalls forever */ }) });
    const { rerender } = renderWithQc(
      <DimensionProposal data={data} onApply={noop} onCancel={noop} busy={false} />,
    );
    expect(document.querySelectorAll('[data-conflict]').length).toBe(0);

    // Simulate the parent passing apply-422 failures down (replicates
    // useInferDimensions' onError handler flow).
    rerender(
      <QueryClientProvider client={makeQc()}>
        <DimensionProposal
          data={data}
          applyCoherenceFailures={['Scene']}
          onApply={noop}
          onCancel={noop}
          busy={false}
        />
      </QueryClientProvider>,
    );
    expect(document.querySelector('[data-conflict="Scene"]')).toBeTruthy();
    // The fallback conflict carries rescueAttempted:true so the Rescue
    // button is greyed (the server has no record of this conflict).
    expect(queryBtn(calloutFor('Scene'), /Rescue with AI/i)?.disabled).toBe(true);
  });
});
