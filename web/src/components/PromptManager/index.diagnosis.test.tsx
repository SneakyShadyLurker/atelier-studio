import type { LibraryDiagnosisResponse, PromptLibraryResponse } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { libraryDiagnosisKeys } from '../../api/libraryDiagnosis';
import { promptKeys } from '../../api/prompts';
import { useAtelierStore } from '../../store/atelier';
import PromptManager from './index';

const templateA = {
  id: 'diag-tpl-0001-1111-7000-8000-000000000001',
  name: 'BrokenA',
  body: 'photorealistic {{var::era}} portrait',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 2,
};

const templateB = {
  id: 'diag-tpl-0001-1111-7000-8000-000000000002',
  name: 'OK',
  body: 'simple prompt',
  sortOrder: 1,
  createdAt: 1,
  updatedAt: 2,
};

const library: PromptLibraryResponse = {
  templates: [templateA, templateB],
  variableLists: [],
  dimensions: [],
};

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderWithDiagnosis(diagnosis: LibraryDiagnosisResponse) {
  const onBack = mock(() => undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(promptKeys.library(), library);
  client.setQueryData(libraryDiagnosisKeys.current(), diagnosis);
  globalThis.fetch = mock(() => Response.json(library)) as unknown as typeof fetch;
  return {
    onBack,
    client,
    ...render(<PromptManager onBack={onBack} />, { wrapper: wrapper(client) }),
  };
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ promptManagerTab: 'templates', toasts: [] });
});

describe('PromptManager diagnosis badges', () => {
  test('AI button opens DiagnosisCard (library mode) when library is broken; Fix with AI sends no body (server recomputes)', async () => {
    const diagnosis: LibraryDiagnosisResponse = {
      templates: [
        { templateName: 'BrokenA', satisfiable: false, reason: 'incompatible dimension tags' },
      ],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    };

    // Capture the fetch call that the infer hook will make when Fix with AI is clicked.
    // The server now owns the prior-diagnosis recomputation — the client must NOT
    // send priorDiagnosis in the body.
    let capturedInit: RequestInit | undefined;
    const fetchSpy = mock((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/dimensions/infer')) {
        capturedInit = init;
        // Return a minimal SSE done event so the hook transitions away from 'analyzing'
        return Promise.resolve(new Response(
          ':keepalive\n\nevent: done\ndata: {"proposalId":"","proposal":{"bundles":[]},"baseSnapshotHash":"h","warnings":[],"coverage":[],"rejected":[],"conflicts":[]}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ));
      }
      if (url.includes('library-diagnosis')) {
        // Return the seeded diagnosis so the pre-flight check resolves with the
        // broken state and opens the DiagnosisCard.
        return Promise.resolve(Response.json(diagnosis));
      }
      return Promise.resolve(Response.json(library));
    });

    renderWithDiagnosis(diagnosis);
    // Override the fetch mock set by renderWithDiagnosis with our URL-aware spy
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Switch to the Dimensions tab where the AI button lives
    const dimensionsTab = await screen.findByRole('tab', { name: /dimensions/i });
    fireEvent.click(dimensionsTab);

    // 1. Click the AI button — only visible in the Dimensions tab
    const aiButton = await screen.findByRole('button', { name: /Propose Dimensions/i });
    fireEvent.click(aiButton);

    // 2. DiagnosisCard should appear with the broken template name
    await waitFor(() => {
      expect(screen.getByText('BrokenA')).toBeTruthy();
    });
    const fixBtn = screen.getByRole('button', { name: 'Fix Library' });
    expect(fixBtn).toBeTruthy();

    // 3. Click "✦ Fix Library" — triggers infer.analyze() with no client-supplied diagnosis
    fireEvent.click(fixBtn);

    // 4. Assert the LLM call was made and the body does NOT contain priorDiagnosis.
    await waitFor(() => {
      expect(capturedInit).toBeDefined();
    });
    // Body must be absent — server recomputes from its own DB.
    expect(capturedInit?.body).toBeUndefined();
  });

  test('renders warn badge when a template is flagged unsatisfiable', async () => {
    const diagnosis: LibraryDiagnosisResponse = {
      templates: [
        { templateName: 'BrokenA', satisfiable: false, reason: 'no satisfying combination' },
        { templateName: 'OK', satisfiable: true },
      ],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    };
    const { container } = renderWithDiagnosis(diagnosis);

    // Warn badge for BrokenA is a button with aria-label containing "unsatisfiable"
    const warnBtn = await screen.findByRole('button', { name: /BrokenA.*unsatisfiable/i });
    expect(warnBtn).toBeTruthy();
    expect(warnBtn.getAttribute('data-coherence')).toBe('unsatisfiable');

    // Satisfiable templates render no badge — negative-space communicates "fine".
    // The ✓ mark was visual noise on every working row and was removed.
    const okMark = container.querySelector('[data-coherence="ok"]');
    expect(okMark).toBeNull();
  });

  test('clicking the warn badge opens the template-scoped DiagnosisCard', async () => {
    const diagnosis: LibraryDiagnosisResponse = {
      templates: [
        { templateName: 'BrokenA', satisfiable: false, reason: 'incompatible dimension tags' },
        { templateName: 'OK', satisfiable: true },
      ],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    };
    renderWithDiagnosis(diagnosis);

    const warnBtn = await screen.findByRole('button', { name: /BrokenA.*unsatisfiable/i });
    fireEvent.click(warnBtn);

    // DiagnosisCard should appear with the template name visible
    await waitFor(() => {
      expect(screen.getByText(/BrokenA/)).toBeTruthy();
    });
  });

  test('no badges when diagnosis has not loaded', async () => {
    // Render without seeding diagnosis data (no setQueryData for diagnosis key)
    const onBack = mock(() => undefined);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(promptKeys.library(), library);
    // Diagnosis fetch hangs (never resolves)
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('library-diagnosis')) return new Promise<Response>(() => undefined);
      return Response.json(library);
    }) as unknown as typeof fetch;

    const { container } = render(<PromptManager onBack={onBack} />, { wrapper: wrapper(client) });
    await screen.findByText('BrokenA');

    expect(container.querySelector('[data-coherence]')).toBeNull();
  });
});
