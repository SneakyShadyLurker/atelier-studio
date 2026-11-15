import { useDeferredValue, useEffect, useId, useMemo, useRef, ViewTransition, type ReactNode } from 'react';
import type { AdminProvider } from '@atelier/shared';
import { runWhenReachable } from '../../lib/focus';
import { takeTextModelsArrivalFocus } from '../../lib/textModelsNav';
import { useAtelierStore, type TextModelsTab } from '../../store/atelier';
import { useRovingTabIndex } from '../../hooks/useRovingTabIndex';
import { useTextModels } from '../../hooks/useTextModels';
import { useTextAdminState } from '../../hooks/useTextModelsAccess';
import { useTextProviders } from '../../hooks/useTextProviders';
import { ManagedViewHeader } from '../ManagedViewHeader';
import { ErrorState, LoadingState } from '../StateView';
import tabs from '../../styles/tabs.module.css';
import ProvidersTab from './ProvidersTab';
import SharedSetup from './SharedSetup';
import YourPicks, { NoTextModelState } from './YourPicks';
import styles from './index.module.css';

const TABS: readonly { readonly id: TextModelsTab; readonly label: string }[] = [
  { id: 'shared', label: 'Shared setup' },
  { id: 'picks', label: 'Your picks' },
  { id: 'providers', label: 'Providers' },
];

/** With no tab chosen this session: Providers until one exists, then Shared setup. */
function defaultTab(providers: readonly AdminProvider[]): TextModelsTab {
  return providers.length === 0 ? 'providers' : 'shared';
}

interface TextModelsProps {
  readonly onBack: () => void;
}

/**
 * Text models for every signed-in person: a text admin sees Shared setup,
 * Your picks and Providers as tabs; everyone else sees Your picks alone.
 */
export default function TextModels({ onBack }: TextModelsProps) {
  const headingId = useId();
  const tabIdBase = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Arriving from a TextModelNote's "Set up text models" lands focus here.
  useEffect(() => {
    if (!takeTextModelsArrivalFocus()) return;
    const heading = headingRef.current;
    runWhenReachable(() => { heading?.focus(); }, heading);
  }, []);
  const probe = useTextProviders();
  const admin = useTextAdminState();
  const models = useTextModels();
  const chosenTab = useAtelierStore((state) => state.textModelsTab);
  const setTab = useAtelierStore((state) => state.setTextModelsTab);

  const providers = probe.data?.providers;
  const tab = chosenTab ?? (providers === undefined ? 'shared' : defaultTab(providers));
  // Shared setup gives way to the empty state while no model is listed.
  const noModels = models.data?.models.length === 0;
  // One render snapshot: a tab change or the empty state swaps its panel in a
  // Transition through a part boundary; the strip itself follows the live tab.
  const liveSnapshot = useMemo(() => ({ tab, noModels }), [tab, noModels]);
  const snapshot = useDeferredValue(liveSnapshot);
  const activeTabIndex = Math.max(0, TABS.findIndex((item) => item.id === tab));
  const tabRoving = useRovingTabIndex<HTMLButtonElement>(TABS.length, activeTabIndex, { orientation: 'horizontal' });
  const goToProviders = () => { setTab('providers'); };
  const tabId = (id: TextModelsTab) => `${tabIdBase}-tab-${id}`;
  const panelId = (id: TextModelsTab) => `${tabIdBase}-tabpanel-${id}`;

  const panelContent = (id: TextModelsTab, list: readonly AdminProvider[]): ReactNode => {
    if (id === 'providers') return <ProvidersTab providers={list} />;
    if (id === 'picks') {
      return <div className={styles.column}><YourPicks admin onGoToProviders={goToProviders} /></div>;
    }
    return snapshot.noModels
      ? <NoTextModelState admin onGoToProviders={goToProviders} />
      : <div className={styles.column}><SharedSetup providers={list} /></div>;
  };

  let content: ReactNode;
  if (admin === 'pending') {
    content = <LoadingState label="Loading text models…" />;
  } else if (admin === 'error' || (admin === 'yes' && providers === undefined)) {
    content = <ErrorState message="Couldn’t load the text models." onRetry={() => { void probe.refetch(); }} />;
  } else if (admin === 'no') {
    content = (
      <div className={styles.body} data-zone="body">
        <div className={styles.column}><YourPicks admin={false} /></div>
      </div>
    );
  } else {
    const list = providers ?? [];
    content = (
      <div className={styles.body} data-zone="body">
        {TABS.map((item) => (
          <div
            key={item.id}
            className={styles.tabPanel}
            role="tabpanel"
            id={panelId(item.id)}
            aria-labelledby={tabId(item.id)}
            tabIndex={0}
            hidden={snapshot.tab !== item.id}
          >
            {snapshot.tab === item.id && (
              <ViewTransition key={snapshot.noModels && item.id === 'shared' ? 'shared-empty' : item.id} default="none" enter="part-enter" exit="part-exit">
                {panelContent(item.id, list)}
              </ViewTransition>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <section className={styles.view} aria-labelledby={headingId}>
      <div className={styles.head} data-zone="head">
        <ManagedViewHeader heading="Text models" headingId={headingId} headingRef={headingRef} backLabel="Back to Unsorted" onBack={onBack}>
          {admin === 'yes' && providers !== undefined ? (
            <div className={tabs.strip} role="tablist" aria-label="Text models sections" onKeyDown={tabRoving.onKeyDown}>
              {TABS.map((item, index) => (
                <button
                  key={item.id}
                  ref={(node) => {
                    tabRoving.rowRefs.current[index] = node;
                  }}
                  id={tabId(item.id)}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls={panelId(item.id)}
                  tabIndex={tab === item.id ? 0 : -1}
                  className={tab === item.id ? tabs.tabActive : tabs.tab}
                  onClick={() => { setTab(item.id); }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </ManagedViewHeader>
      </div>
      {content}
    </section>
  );
}
