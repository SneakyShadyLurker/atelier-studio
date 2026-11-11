import type { LibraryDiagnosisResponse, PromptTemplate, TagDimension, VariableList } from '@atelier/shared';
import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { useDeferredValue, useEffect, useId, useRef, useState, useSyncExternalStore, ViewTransition, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCreateDimension,
  useCreateList,
  useDeleteDimension,
  useDeleteList,
  useDeleteTemplate,
  usePatchDimension,
  useReorderLists,
  useReorderTemplates,
} from '../../hooks/usePromptMutations';
import { useInferDimensions } from '../../hooks/useInferDimensions';
import { useTextModelGate } from '../../hooks/useTextModelGate';
import { goToTextModels } from '../../lib/textModelsNav';
import { usePromptLibrary } from '../../hooks/usePromptLibrary';
import { describeError } from '../../lib/errorCopy';
import { LoadingState, ErrorState, StateView } from '../StateView';
import { useInlineEdit } from '../../hooks/useInlineEdit';
import { useRovingTabIndex } from '../../hooks/useRovingTabIndex';
import { useVerticalDragReorder } from '../../hooks/useVerticalDragReorder';
import type { InferProgressNotification } from '../../api/inferDimensions';
import { libraryDiagnosisOpts } from '../../api/libraryDiagnosis';
import { libraryCoverageOpts } from '../../api/libraryCoverage';
import { coverageBadgeState } from './coverageBadge';
import { CoverageCard } from './CoverageCard';
import { useAtelierStore, type PromptManagerTab } from '../../store/atelier';
import ConfirmDialog from '../ConfirmDialog';
import { I } from '../icons/I';
import { ManagedViewHeader } from '../ManagedViewHeader';
import DimensionEditor from './DimensionEditor';
import DimensionProposal from './DimensionProposal';
import { DiagnosisCard } from './DiagnosisCard';
import HelpPanel from './HelpPanel';
import TextModelNote from '../TextModelNote';
import ListEditor from './ListEditor';
import SettingsPanel from './SettingsPanel';
import TemplateEditor from './TemplateEditor';
import { PromptDraftStore, usePromptDraftStore, type PromptSelection } from './draftStore';
import styles from './index.module.css';
import btn from '../../styles/buttons.module.css';

// Inline edit is create-only. Renaming happens in each editor's name field
// (consistent Save semantics across all three editors) — the undiscoverable,
// hover/double-click-dependent rail rename was removed for symmetry.
type InlineKind = 'creating';
interface InlineContext { readonly kind: 'creating'; readonly tab: PromptManagerTab }

type DeleteTarget =
  | { readonly kind: 'template'; readonly item: PromptTemplate }
  | { readonly kind: 'list'; readonly item: VariableList }
  | { readonly kind: 'dimension'; readonly item: TagDimension };

function aiButtonLabel(
  status: 'idle' | 'analyzing' | 'review' | 'applying' | 'error',
  progress: InferProgressNotification | null,
): string {
  if (status !== 'analyzing') return 'Propose Dimensions';
  if (!progress) return 'Analyzing...';
  switch (progress.phase) {
    case 'taxonomy':
      return 'Analyzing taxonomy...';
    case 'chunks':
      if (progress.progress) return `${progress.progress.done}/${progress.progress.total} chunks`;
      return 'Analyzing chunks...';
    case 'retry-gaps':
      if (progress.progress) {
        const remaining = progress.progress.total - progress.progress.done;
        return `Retrying ${remaining} of ${progress.progress.total}...`;
      }
      return 'Retrying...';
    case 'finalize':
      return 'Finalizing...';
    default: {
      const _exhaustive: never = progress.phase;
      throw new Error(`unhandled phase: ${_exhaustive as string}`);
    }
  }
}

const TABS: readonly { readonly id: PromptManagerTab; readonly label: string }[] = [
  { id: 'templates', label: 'Templates' },
  { id: 'lists', label: 'Variable lists' },
  { id: 'dimensions', label: 'Dimensions' },
  { id: 'settings', label: 'Settings' },
];

interface PromptManagerProps {
  onBack: () => void;
}



export default function PromptManager({ onBack }: PromptManagerProps) {
  const inputId = useId();
  const helpPanelId = useId();
  const managerTitleId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpExitRef = useRef<(() => void) | null>(null);
  const helpBtnRef = useRef<HTMLButtonElement | null>(null);
  const promptLibrary = usePromptLibrary();
  const tab = useAtelierStore((state) => state.promptManagerTab);
  const setTab = useAtelierStore((state) => state.setPromptManagerTab);
  const addToast = useAtelierStore((state) => state.addToast);
  const draftStore = usePromptDraftStore();
  const [selectionStore] = useState(() => draftStore ?? new PromptDraftStore());
  const { templateId: selectedTemplateId, listId: selectedListId, dimensionId: selectedDimensionId, newTemplateName } = useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSelection,
  );
  const listPruneRevision = useSyncExternalStore(selectionStore.subscribe, selectionStore.getListPruneRevision);
  const setSelection = (patch: Partial<PromptSelection>) => {
    selectionStore.setSelection({ ...selectionStore.getSelection(), ...patch });
  };
  const setSelectedTemplateId = (templateId: string | null) => { setSelection({ templateId }); };
  const setSelectedListId = (listId: string | null) => { setSelection({ listId }); };
  const setSelectedDimensionId = (dimensionId: string | null) => { setSelection({ dimensionId }); };
  const setNewTemplateName = (name: string | null) => { setSelection({ newTemplateName: name }); };
  const [inlineContext, setInlineContext] = useState<InlineContext | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const templateLiRefs = useRef(new Map<string, HTMLLIElement | null>());
  const listLiRefs = useRef(new Map<string, HTMLLIElement | null>());

  const createList = useCreateList();
  const createDimension = useCreateDimension();
  const patchDimension = usePatchDimension();
  const deleteTemplate = useDeleteTemplate();
  const deleteList = useDeleteList();
  const deleteDimension = useDeleteDimension();
  const reorderTemplates = useReorderTemplates();
  const reorderLists = useReorderLists();
  const infer = useInferDimensions();
  const diagnosisQuery = useQuery(libraryDiagnosisOpts());
  const coverageQuery = useQuery(libraryCoverageOpts());
  const [coverageCardOpen, setCoverageCardOpen] = useState(false);
  type DiagnosisCardOpen =
    | { mode: 'library' }
    | { mode: 'template'; templateName: string };
  const [liveDiagnosisCard, setDiagnosisCardOpen] = useState<DiagnosisCardOpen | null>(null);
  // The card is inline page content: it renders from a deferred snapshot so
  // opening, Cancel and Fix with AI mount and unmount it in a Transition
  // through its part boundary.
  const diagnosisCardOpen = useDeferredValue(liveDiagnosisCard);
  const queryClient = useQueryClient();
  // Propose Dimensions and the diagnosis fix stay enabled without a text
  // model; with none configured at all they open the note under the button.
  const textModelGate = useTextModelGate();
  const proposeButtonRef = useRef<HTMLButtonElement | null>(null);
  const fixButtonRef = useRef<HTMLButtonElement | null>(null);
  const [textNote, setTextNote] = useState<{ action: string; anchorRef: RefObject<HTMLButtonElement | null> } | null>(null);
  const onAiClick = async () => {
    let fresh: LibraryDiagnosisResponse;
    try {
      // Always refetch with staleTime:0 — stale cache cannot be trusted for
      // a security-relevant pre-flight check.
      fresh = await queryClient.query({ ...libraryDiagnosisOpts(), staleTime: 0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      addToast(
        `Couldn't check library health (${msg}). Try again — we won't proceed to the AI call until the check succeeds.`,
        'error',
      );
      return;
    }
    const needsDiagnosisContext = fresh.templates.some((t) => t.satisfiable === false);
    if (needsDiagnosisContext) {
      setDiagnosisCardOpen({ mode: 'library' });
      return;
    }
    infer.analyze();
  };

  const library = promptLibrary.data;
  const templates = library?.templates ?? [];
  const lists = library?.variableLists ?? [];
  const dimensions = library?.dimensions ?? [];
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const listById = new Map(lists.map((list) => [list.id, list]));
  const dimensionById = new Map(dimensions.map((dimension) => [dimension.id, dimension]));

  const selectedTemplate = newTemplateName !== null
    ? null
    : (selectedTemplateId ? templateById.get(selectedTemplateId) : undefined) ?? templates[0] ?? null;
  const selectedList = (selectedListId ? listById.get(selectedListId) : undefined) ?? lists[0] ?? null;
  const selectedDimension = (selectedDimensionId ? dimensionById.get(selectedDimensionId) : undefined) ?? dimensions[0] ?? null;

  const activeTemplateIndex = Math.max(0, selectedTemplate ? templates.indexOf(selectedTemplate) : -1);
  const activeListIndex = Math.max(0, selectedList ? lists.indexOf(selectedList) : -1);
  const activeDimensionIndex = Math.max(0, selectedDimension ? dimensions.indexOf(selectedDimension) : -1);
  const activeTabIndex = Math.max(0, TABS.findIndex((item) => item.id === tab));
  const tabRoving = useRovingTabIndex<HTMLButtonElement>(TABS.length, activeTabIndex, { orientation: 'horizontal' });
  // The phone tab strip scrolls sideways: keep the active tab in view (on
  // mount too, so a restored Settings tab is not parked past the edge). Only
  // the strip scrolls; scrollIntoView would also move the page.
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const revealActive = () => {
      const active = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!active || strip.scrollWidth <= strip.clientWidth) return;
      const stripBox = strip.getBoundingClientRect();
      const tabBox = active.getBoundingClientRect();
      const edge = Number.parseFloat(getComputedStyle(strip).scrollPaddingInlineStart) || 0;
      if (tabBox.left < stripBox.left + edge) strip.scrollBy({ left: tabBox.left - (stripBox.left + edge) });
      else if (tabBox.right > stripBox.right - edge) strip.scrollBy({ left: tabBox.right - (stripBox.right - edge) });
    };
    revealActive();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealActive);
    observer.observe(strip);
    return () => { observer.disconnect(); };
  }, [tab]);
  const templateRoving = useRovingTabIndex<HTMLButtonElement>(templates.length, activeTemplateIndex);
  const listRoving = useRovingTabIndex<HTMLButtonElement>(lists.length, activeListIndex);
  const dimensionRoving = useRovingTabIndex<HTMLButtonElement>(dimensions.length, activeDimensionIndex);

  const commitInline = (kind: InlineKind, draft: string) => {
    const name = draft.trim();
    const context = inlineContext;
    setInlineContext(null);
    if (!name || name.length > PROMPT_LIBRARY_NAME_MAX_CHARS || context?.kind !== kind) return;
    if (context.tab === 'templates') {
      setNewTemplateName(name);
      setSelectedTemplateId(null);
      return;
    }
    if (context.tab === 'lists') {
      createList.mutateAsync({ name })
        .then((list) => {
          setSelectedListId(list.id);
          addToast('Variable list created');
        })
        .catch((error: unknown) => { addToast(describeError(error, "Couldn't create the variable list."), 'error'); });
      return;
    }
    createDimension.mutateAsync({ name })
      .then((dimension) => {
        setSelectedDimensionId(dimension.id);
        addToast('Dimension created');
      })
      .catch((error: unknown) => { addToast(describeError(error, "Couldn't create the dimension."), 'error'); });
  };

  const inlineEdit = useInlineEdit<InlineKind>({
    commitOnBlur: false,
    onCommit: commitInline,
    onCancel: () => { setInlineContext(null); },
  });

  useEffect(() => {
    if (inlineEdit.isActive) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [inlineEdit.isActive]);

  const renderInlineInput = (label: string) => (
    <div className={styles.inlineInputWrap}>
      <label className="srOnly" htmlFor={inputId}>{label}</label>
      <input
        maxLength={PROMPT_LIBRARY_NAME_MAX_CHARS}
        ref={inputRef}
        id={inputId}
        className={styles.inlineInput}
        {...inlineEdit.inputProps}
      />
    </div>
  );

  const startCreate = (nextTab: PromptManagerTab) => {
    setTab(nextTab);
    if (nextTab === 'templates') {
      const savedNewDraft = draftStore?.getTemplate('new');
      if (savedNewDraft) {
        setNewTemplateName(savedNewDraft.name);
        setSelectedTemplateId(null);
        return;
      }
    }
    setInlineContext({ kind: 'creating', tab: nextTab });
    inlineEdit.begin('creating');
  };

  const templateIds = templates.map((t) => t.id);
  const listIds = lists.map((l) => l.id);

  const templateReorder = useVerticalDragReorder({
    ids: templateIds,
    onReorder: (orderedIds) => {
      setSelectedTemplateId(selectedTemplate?.id ?? null);
      reorderTemplates.mutate({ orderedIds });
    },
    getRowElement: (id) => templateLiRefs.current.get(id) ?? null,
    thresholdPx: 4,
    dropIndicator: true,
    allowKeyboard: true,
    onAnnounce: setLiveAnnouncement,
  });

  const listReorder = useVerticalDragReorder({
    ids: listIds,
    onReorder: (orderedIds) => {
      setSelectedListId(selectedList?.id ?? null);
      reorderLists.mutate({ orderedIds });
    },
    getRowElement: (id) => listLiRefs.current.get(id) ?? null,
    thresholdPx: 4,
    dropIndicator: true,
    allowKeyboard: true,
    onAnnounce: setLiveAnnouncement,
  });

  const confirmDelete = () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    if (target.kind === 'template') {
      deleteTemplate.mutateAsync(target.item.id)
        .then(() => {
          draftStore?.deleteTemplate(target.item.id);
          addToast('Template deleted');
        })
        .catch((error: unknown) => { addToast(describeError(error, "Couldn't delete the template."), 'error'); });
      return;
    }
    if (target.kind === 'list') {
      deleteList.mutateAsync(target.item.id)
        .then(() => {
          draftStore?.deleteList(target.item.id);
          addToast('Variable list deleted');
        })
        .catch((error: unknown) => { addToast(describeError(error, "Couldn't delete the variable list."), 'error'); });
      return;
    }
    deleteDimension.mutateAsync(target.item.id)
      .then(() => {
          draftStore?.deleteDimension(target.item.id);
          draftStore?.pruneListTagIds(new Set(target.item.tags.map((tag) => tag.id)));
          addToast('Dimension deleted');
      })
      .catch((error: unknown) => { addToast(describeError(error, "Couldn't delete the dimension."), 'error'); });
  };

  // An empty resource list shows only its empty state (decision 9): the list
  // pane would be an empty card beside it, so it stays out until something
  // other than the empty state renders (the inline name field, a new draft).
  const templatesEmpty = templates.length === 0 && newTemplateName === null && !selectedTemplate && !inlineEdit.isActive;
  const listsEmpty = lists.length === 0 && !inlineEdit.isActive;
  const dimensionsEmpty = dimensions.length === 0 && !inlineEdit.isActive;
  const proposeButton = (
    <button
      type="button"
      className={btn.ai}
      ref={proposeButtonRef}
      onClick={() => {
        if (textModelGate.availability === 'none') setTextNote({ action: 'Propose Dimensions', anchorRef: proposeButtonRef });
        else void onAiClick();
      }}
      disabled={infer.status === 'analyzing' || infer.status === 'applying'}
    >
      <I.sparkle aria-hidden="true" />
      {aiButtonLabel(infer.status, infer.progress)}
    </button>
  );

  return (
    <section className={styles.manager} aria-labelledby={managerTitleId}>
      <ManagedViewHeader
        heading="Prompt Library"
        headingId={managerTitleId}
        backLabel="Back to Unsorted"
        onBack={onBack}
        titleAction={(
  <button
            ref={helpBtnRef}
            type="button"
            className={btn.icon}
            aria-label="How the Prompt Library works"
            aria-expanded={helpOpen}
            aria-controls={helpOpen ? helpPanelId : undefined}
            data-tip="How it works"
            data-tip-place="below"
            onClick={() => {
              // Closing plays the panel's exit, like every other dismissal.
              if (helpOpen && helpExitRef.current) helpExitRef.current();
              else setHelpOpen((v) => !v);
            }}
          >
            <I.info />
          </button>
        )}
      >
        <div ref={tabStripRef} className={styles.headerTabs} role="tablist" aria-label="Prompt Library sections" onKeyDown={tabRoving.onKeyDown}>
          {TABS.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                tabRoving.rowRefs.current[index] = node;
              }}
              id={`tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`tabpanel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={tab === item.id ? styles.tabActive : styles.tab}
              onClick={() => { setTab(item.id); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </ManagedViewHeader>

      {promptLibrary.isLoading ? (
        <LoadingState label="Loading Prompt Library…" />
      ) : promptLibrary.isError ? (
        <ErrorState message="Couldn’t load the Prompt Library." onRetry={() => { void promptLibrary.refetch(); }} />
      ) : !promptLibrary.enabled || !library ? null : (
        <>

        <div className={styles.body} role="tabpanel" id="tabpanel-templates" aria-labelledby="tab-templates" tabIndex={0} hidden={tab !== 'templates'}>
        {tab === 'templates' && (
          <>
            {!templatesEmpty && (
            <aside className={styles.resourcePane} aria-label="Templates" onKeyDown={templateRoving.onKeyDown}>
              <div className={styles.paneNew}>
                {inlineContext?.kind === 'creating' && inlineContext.tab === 'templates'
                  ? renderInlineInput('Template name')
                  : templates.length > 0 && (
                    <button type="button" className={btn.secondary} onClick={() => { startCreate('templates'); }}>
                      <I.plus aria-hidden="true" />New
                    </button>
                    )}
              </div>
              <div className={styles.resourceScroll}>
              <ul className={styles.resourceList} role="list" data-drag-active={templateReorder.isDragging ? 'true' : 'false'}>
                {templates.map((template, index) => {
                  const active = newTemplateName === null && selectedTemplate?.id === template.id;
                  const pointerHandlers = templateReorder.pointerHandlers(template.id);
                  const keyboardHandlers = templateReorder.keyboardHandlers(template.id);
                  return (
                    <li
                      key={template.id}
                      className={styles.resourceItem}
                      ref={(node) => { if (node) templateLiRefs.current.set(template.id, node); else templateLiRefs.current.delete(template.id); }}
                    >
                      <div className={styles.rowLeft}>
                        <button
                          ref={(node) => {
                            templateRoving.rowRefs.current[index] = node;
                          }}
                          className={active ? `${styles.resourceBtnActive} railActiveBar` : styles.resourceBtn}
                          type="button"
                          aria-pressed={active}
                          onClick={(event) => {
                            if (templateReorder.suppressClick(template.id)) {
                              event.preventDefault();
                              return;
                            }
                            setNewTemplateName(null);
                            setSelectedTemplateId(template.id);
                          }}
                          {...pointerHandlers}
                          {...(keyboardHandlers ?? {})}
                        >
                          <span className={styles.grip}><I.grip /></span>
                          <span className={styles.resourceMain}>
                            <span>{template.name}</span>
                          </span>
                        </button>
                        {(() => {
                          const entry = diagnosisQuery.data?.templates.find((t) => t.templateName === template.name);
                          if (!entry || entry.satisfiable === true) return null;
                          const incomplete = entry.satisfiable === null;
                          return (
                            <button
                              type="button"
                              data-tip={incomplete ? 'Diagnosis incomplete — the check reached its work limit' : entry.reason ?? 'Template fails the SAT solver — click to see why'}
                              data-coherence={incomplete ? 'incomplete' : 'unsatisfiable'}
                              className={styles.warnBadge}
                              aria-label={`${template.name}: ${incomplete ? 'diagnosis incomplete' : 'unsatisfiable'}`}
                              onClick={() => {
                                setDiagnosisCardOpen({ mode: 'template', templateName: template.name });
                                setTab('dimensions');
                              }}
                            >
                              <I.warn />
                            </button>
                          );
                        })()}
                      </div>
                      <button
                        className={btn.iconAction}
                        type="button"
                        aria-label={`Delete template ${template.name}`}
                        data-tip="Delete template"
                        onClick={() => { setDeleteTarget({ kind: 'template', item: template }); }}
                      >
                        <I.trash />
                      </button>
                    </li>
                  );
                })}
                {templateReorder.dropIndicatorTop !== null && (
                  <li
                    aria-hidden="true"
                    className={styles.dropIndicator}
                    style={{ transform: `translateY(${templateReorder.dropIndicatorTop}px)` }}
                  />
                )}
              </ul>
              </div>
            </aside>
            )}
            {newTemplateName !== null || selectedTemplate ? (
              <TemplateEditor
                key={newTemplateName !== null ? 'new' : selectedTemplate?.id}
                template={selectedTemplate}
                initialName={newTemplateName ?? ''}
                variableLists={lists}
                onDelete={newTemplateName === null && selectedTemplate ? () => { setDeleteTarget({ kind: 'template', item: selectedTemplate }); } : undefined}
                onCreated={(created) => {
                  // Async completion must not jump away from a resource the
                  // user selected while the create request was in flight.
                  // The current manager observes this even if the one that
                  // started the request has since unmounted.
                  selectionStore.adoptCreatedTemplate(created.id);
                }}
              />
            ) : templatesEmpty ? (
              <div className={styles.emptySpan} data-empty-span="">
                <StateView
                  art="empty-templates"
                  title="No templates yet"
                  body={(
                    <>
                      A template is a reusable prompt with slots: write <code>{'{{var::name}}'}</code> to pull from a
                      Variable list, or <code>{'{{random::a::b}}'}</code> for an inline one-off choice. Start one and it
                      opens here.
                    </>
                  )}
                  action={{ label: 'New template', onClick: () => { startCreate('templates'); } }}
                />
              </div>
            ) : null}
          </>
        )}
        </div>

        <div className={styles.body} role="tabpanel" id="tabpanel-lists" aria-labelledby="tab-lists" tabIndex={0} hidden={tab !== 'lists'}>
        {tab === 'lists' && (
          <>
            {!listsEmpty && (
            <aside className={styles.resourcePane} aria-label="Lists" onKeyDown={listRoving.onKeyDown}>
              <div className={styles.paneNew}>
                {inlineContext?.kind === 'creating' && inlineContext.tab === 'lists'
                  ? renderInlineInput('Variable list name')
                  : lists.length > 0 && (
                    <button type="button" className={btn.secondary} onClick={() => { startCreate('lists'); }}>
                      <I.plus aria-hidden="true" />New
                    </button>
                    )}
              </div>
              <div className={styles.resourceScroll}>
              <ul className={styles.resourceList} role="list" data-drag-active={listReorder.isDragging ? 'true' : 'false'}>
                {lists.map((list, index) => {
                  const active = selectedList?.id === list.id;
                  const pointerHandlers = listReorder.pointerHandlers(list.id);
                  const keyboardHandlers = listReorder.keyboardHandlers(list.id);
                  return (
                    <li
                      key={list.id}
                      className={styles.resourceItem}
                      ref={(node) => { if (node) listLiRefs.current.set(list.id, node); else listLiRefs.current.delete(list.id); }}
                    >
                      <button
                        ref={(node) => {
                          listRoving.rowRefs.current[index] = node;
                        }}
                        className={active ? `${styles.resourceBtnActive} railActiveBar` : styles.resourceBtn}
                        type="button"
                        aria-pressed={active}
                        aria-label={`Edit list ${list.name}, ${list.options.length} ${list.options.length === 1 ? 'option' : 'options'}`}
                        onClick={(event) => {
                          if (listReorder.suppressClick(list.id)) {
                            event.preventDefault();
                            return;
                          }
                          setSelectedListId(list.id);
                        }}
                        {...pointerHandlers}
                        {...(keyboardHandlers ?? {})}
                      >
                        <span className={styles.grip}><I.grip /></span>
                        <span className={styles.resourceMain}>
                          <span>{list.name}</span>
                          <span className={styles.resourceCount} aria-hidden="true">{list.options.length}</span>
                        </span>
                      </button>
                      <button
                        className={btn.iconAction}
                        type="button"
                        aria-label={`Delete list ${list.name}`}
                        data-tip="Delete list"
                        onClick={() => { setDeleteTarget({ kind: 'list', item: list }); }}
                      >
                        <I.trash />
                      </button>
                    </li>
                  );
                })}
                {listReorder.dropIndicatorTop !== null && (
                  <li
                    aria-hidden="true"
                    className={styles.dropIndicator}
                    style={{ transform: `translateY(${listReorder.dropIndicatorTop}px)` }}
                  />
                )}
              </ul>
              </div>
            </aside>
            )}
            {selectedList && <ListEditor key={`${selectedList.id}:${listPruneRevision}`} list={selectedList} dimensions={dimensions} onDelete={() => { setDeleteTarget({ kind: 'list', item: selectedList }); }} />}
            {listsEmpty && (
              <div className={styles.emptySpan} data-empty-span="">
                <StateView
                  art="empty-lists"
                  title="No variable lists yet"
                  body={(
                    <>
                      A list is one axis a template can roll from, like <em>era</em> or <em>wardrobe</em>, pulled in
                      with <code>{'{{var::name}}'}</code>; edit it once and every template using it updates. Start one
                      and it opens here.
                    </>
                  )}
                  action={{ label: 'New list', onClick: () => { startCreate('lists'); } }}
                />
              </div>
            )}
          </>
        )}
        </div>

        <div className={`${styles.body} ${styles.bodyDimensions}`} role="tabpanel" id="tabpanel-dimensions" aria-labelledby="tab-dimensions" tabIndex={0} hidden={tab !== 'dimensions'}>
        {tab === 'dimensions' && (
          <>
            <div className={styles.dimPaneHeader}>
              {coverageQuery.data && (() => {
                const badge = coverageBadgeState(coverageQuery.data);
                return (
                  <button
                    type="button"
                    data-coverage={badge.tone}
                    className={badge.tone === 'healthy' ? styles.coverageBadgeHealthy : styles.coverageBadgePending}
                    aria-label={
                      badge.tone === 'healthy'
                        ? 'Coverage healthy — open coverage report'
                        : `Coverage: ${badge.untaggedCount} untagged options — open coverage report`
                    }
                    data-tip="Library coverage"
                    onClick={() => { setCoverageCardOpen(true); }}
                  >
                    {badge.tone === 'healthy' ? <><I.check />Coverage</> : <>Coverage, {badge.untaggedCount}</>}
                  </button>
                );
              })()}
              {dimensionsEmpty && proposeButton}
            </div>
            {!dimensionsEmpty && (
            <aside className={styles.resourcePane} aria-label="Dimensions" onKeyDown={dimensionRoving.onKeyDown}>
              <div className={styles.paneNew}>
                {inlineContext?.kind === 'creating' && inlineContext.tab === 'dimensions'
                  ? renderInlineInput('Dimension name')
                  : (
                    <>
                      {dimensions.length > 0 && (
                        <button type="button" className={btn.secondary} onClick={() => { startCreate('dimensions'); }}>
                          <I.plus aria-hidden="true" />New
                        </button>
                      )}
                      {proposeButton}
                    </>
                    )}
              </div>
              <div className={styles.resourceScroll}>
              <ul className={styles.resourceList} role="list">
                {dimensions.map((dimension, index) => {
                  const active = selectedDimension?.id === dimension.id;
                  return (
                    <li key={dimension.id} className={styles.resourceItem}>
                      <button
                        ref={(node) => {
                          dimensionRoving.rowRefs.current[index] = node;
                        }}
                        className={active ? `${styles.resourceBtnActive} railActiveBar` : styles.resourceBtn}
                        type="button"
                        aria-pressed={active}
                        aria-label={`Edit dimension ${dimension.name}, ${dimension.tags.length} ${dimension.tags.length === 1 ? 'tag' : 'tags'}`}
                        onClick={() => { setSelectedDimensionId(dimension.id); }}
                      >
                        <span className={styles.resourceMain}>
                          <span>{dimension.name}</span>
                          <span className={styles.resourceCount} aria-hidden="true">{dimension.tags.length}</span>
                        </span>
                      </button>
                      <button
                        className={btn.iconAction}
                        type="button"
                        aria-label={`Delete dimension ${dimension.name}`}
                        data-tip="Delete dimension"
                        onClick={() => { setDeleteTarget({ kind: 'dimension', item: dimension }); }}
                      >
                        <I.trash />
                      </button>
                    </li>
                  );
                })}
              </ul>
              </div>
            </aside>
            )}
            {dimensionsEmpty && (
              <div className={styles.emptySpan} data-empty-span="">
                <StateView
                  art="empty-dimensions"
                  title="No dimensions yet"
                  body={(
                    <>
                      Dimensions keep random rolls coherent: create one (e.g. <em>epoch</em>), give it
                      mutually-exclusive tags (ancient, medieval, modern, future), then tag your list options — options
                      that share a dimension but no tag can never be rolled together.
                    </>
                  )}
                  action={{ label: 'New dimension', onClick: () => { startCreate('dimensions'); } }}
                />
              </div>
            )}
            {selectedDimension && (
              <DimensionEditor
                key={selectedDimension.id}
                dimension={selectedDimension}
                renamePending={patchDimension.isPending}
                onDelete={() => { setDeleteTarget({ kind: 'dimension', item: selectedDimension }); }}
                onRename={(name, description) => {
                  return patchDimension.mutateAsync({
                    id: selectedDimension.id,
                    name,
                    ...(description !== undefined ? { description: description.length > 0 ? description : null } : {}),
                  });
                }}
              />
            )}
            {diagnosisCardOpen && diagnosisQuery.data && (
              <ViewTransition default="none" enter="part-enter" exit="part-exit">
              <div className={styles.dimFullSpan}>
                <DiagnosisCard
                  {...diagnosisCardOpen}
                  diagnosis={diagnosisQuery.data}
                  fixButtonRef={fixButtonRef}
                  onFixWithAi={(_diagnosis: LibraryDiagnosisResponse, actionLabel: string) => {
                    if (textModelGate.availability === 'none') {
                      setTextNote({ action: actionLabel, anchorRef: fixButtonRef });
                      return;
                    }
                    setDiagnosisCardOpen(null);
                    infer.analyze();
                  }}
                  onCancel={() => { setDiagnosisCardOpen(null); }}
                />
              </div>
              </ViewTransition>
            )}
            {coverageQuery.data && (
              <CoverageCard
                open={coverageCardOpen}
                report={coverageQuery.data}
                onJumpToList={(listId) => {
                  setCoverageCardOpen(false);
                  setSelectedListId(listId);
                  setTab('lists');
                }}
                onCancel={() => { setCoverageCardOpen(false); }}
              />
            )}
            {(infer.status === 'review' || infer.status === 'applying') &&
              infer.proposal && infer.proposalId && infer.baseSnapshotHash && (
                // Key on proposalId so a fresh analysis remounts the panel and
                // re-seeds the picked-set from defaults — without this, the
                // user's checkbox state from a previous proposal leaks into a
                // new one.
                <div className={styles.dimFullSpan}>
                  <DimensionProposal
                    key={infer.proposalId}
                    data={{
                      proposalId: infer.proposalId,
                      proposal: infer.proposal,
                      baseSnapshotHash: infer.baseSnapshotHash,
                      warnings: infer.warnings,
                      coverage: infer.coverage,
                      rejected: infer.rejected,
                      conflicts: infer.conflicts,
                    }}
                    applyCoherenceFailures={infer.applyCoherenceFailures}
                    busy={infer.status === 'applying'}
                    onCancel={() => { infer.reset(); }}
                    onApply={(keys, acceptUnsatisfiableTemplates) => { infer.apply(keys, acceptUnsatisfiableTemplates); }}
                  />
                </div>
              )}
          </>
        )}
        </div>

        <div className={`${styles.body} ${styles.bodySettings}`} role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings" tabIndex={0} hidden={tab !== 'settings'}>
        {tab === 'settings' && <SettingsPanel />}
        </div>

      {deleteTarget && (
        <ConfirmDialog
          open
          title={`Delete ${deleteTarget.kind}?`}
          body="This removes it from the Prompt Library for this user."
          confirmLabel={`Delete ${deleteTarget.kind}`}
          cancelLabel="Cancel"
          danger
          closeOnBackdrop={false}
          onConfirm={confirmDelete}
          onCancel={() => { setDeleteTarget(null); }}
        />
      )}
        </>
      )}
      <HelpPanel
        open={helpOpen}
        panelId={helpPanelId}
        triggerRef={helpBtnRef}
        exitRef={helpExitRef}
        onClose={() => { setHelpOpen(false); }}
      />
      {textNote !== null && (
        <TextModelNote
          open
          action={textNote.action}
          anchorRef={textNote.anchorRef}
          escape="top-level"
          navigateToTextModels={goToTextModels}
          onClose={() => { setTextNote(null); }}
        />
      )}
      <div className="srOnly" aria-live="polite" aria-atomic="true">{liveAnnouncement}</div>
    </section>
  );
}
