import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DimensionChangeBundle,
  InferDimensionsResponse,
  TemplateConflict,
} from '@atelier/shared';
import { rescueDimension } from '../../../api/rescueDimension';
import { usePromptImageContext } from '../../../hooks/usePromptImageContext';
import { diagnoseSelectionOpts } from '../../../api/diagnoseSelection';
import { I } from '../../icons/I';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import styles from './index.module.css';
import btn from '../../../styles/buttons.module.css';
import {
  type ConflictState,
  conflictReducer,
  intentFor,
} from './conflictState';
import {
  type DependencyGroups,
  buildDependencyGroups,
  dependenciesMet,
  effectiveSelection,
  expandToGroups,
  toggleGroup,
} from './dependencySelection';

interface Props {
  data: InferDimensionsResponse;
  /**
   * Templates the server's apply-time coherence check flagged AFTER an Apply
   * attempt. Source: useInferDimensions hook's apply-422 handler. These are
   * MERGED into the local conflicts state on change so the per-template
   * Skip / Apply-anyway controls surface inline, replacing the dead-end toast
   * the user saw before. Distinct from data.conflicts (infer-time diagnosis
   * over the FULL bundle set) — apply-time conflicts depend on the user's
   * subset selection and can be ones the infer didn't predict.
   */
  applyCoherenceFailures?: readonly string[];
  busy: boolean;
  onApply: (keys: string[], acceptUnsatisfiableTemplates: string[]) => void;
  onCancel: () => void;
}

function BundleRow({
  bundle,
  groups,
  effective,
  busy,
  onToggle,
  conflictBadges,
  onBadgeClick,
}: {
  bundle: DimensionChangeBundle;
  groups: DependencyGroups;
  effective: ReadonlySet<string>;
  busy: boolean;
  onToggle: (key: string) => void;
  conflictBadges: readonly string[];
  onBadgeClick: (templateName: string) => void;
}) {
  // Dependencies inside the bundle's own cyclic group never gate it.
  const depsMet = dependenciesMet(groups, effective, bundle.key);
  const isRescue = bundle.kind === 'rescue';
  return (
    <div
      data-bundle-kind={bundle.kind}
      className={`${styles.bundleRowWrap} ${isRescue ? styles.rescueBundle : ''}`}
    >
      <label
        className={`${styles.bundleRow} ${bundle.destructive ? styles.destructive : ''}`}
      >
        <input
          type="checkbox"
          checked={effective.has(bundle.key)}
          disabled={!depsMet || busy}
          onChange={() => { onToggle(bundle.key); }}
        />
        <span className={styles.bundleCopy}>
          {bundle.kind === 'rescue' ? (
            <strong>
              AI added &quot;{bundle.optionValue}&quot; to {bundle.listName} to keep &quot;{bundle.templateName}&quot; usable.
            </strong>
          ) : (
            <strong>{bundle.title}</strong>
          )}
          {bundle.kind !== 'rescue' && bundle.detail ? <span>{bundle.detail}</span> : null}
          {bundle.impact ? <span className={styles.impact}>{bundle.impact}</span> : null}
          {bundle.dependsOn.length > 0 ? (
            <span className={styles.deps}>also applies: {bundle.dependsOn.join(', ')}</span>
          ) : null}
        </span>
      </label>
      {conflictBadges.length > 0 ? (
        <div className={styles.conflictBadges}>
          {conflictBadges.map((templateName) => (
            <button
              key={templateName}
              type="button"
              className={styles.conflictBadge}
              onClick={() => { onBadgeClick(templateName); }}
            >
              Conflicts with &quot;{templateName}&quot;
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  heading,
  bundles,
  groups,
  effective,
  busy,
  onToggle,
  culpritIndex,
  onBadgeClick,
}: {
  heading: string;
  bundles: readonly DimensionChangeBundle[];
  groups: DependencyGroups;
  effective: ReadonlySet<string>;
  busy: boolean;
  onToggle: (key: string) => void;
  culpritIndex: ReadonlyMap<string, readonly string[]>;
  onBadgeClick: (templateName: string) => void;
}) {
  if (bundles.length === 0) return null;
  return (
    <section className={styles.section}>
      <h4>{heading}</h4>
      <div className={styles.bundleList}>
        {bundles.map((bundle) => (
          <BundleRow
            key={bundle.key}
            bundle={bundle}
            groups={groups}
            effective={effective}
            busy={busy}
            onToggle={onToggle}
            conflictBadges={culpritIndex.get(bundle.key) ?? []}
            onBadgeClick={onBadgeClick}
          />
        ))}
      </div>
    </section>
  );
}

function ConflictCallout({
  conflict,
  state,
  busy,
  anyRescueInFlight,
  onSkip,
  onAcceptUnsat,
  onStartRescue,
  onReset,
}: {
  conflict: TemplateConflict;
  state: ConflictState;
  busy: boolean;
  anyRescueInFlight: boolean;
  onSkip: () => void;
  onAcceptUnsat: () => void;
  onStartRescue: () => void;
  onReset: () => void;
}) {
  const skipBlocked = conflict.culpritKind === 'non-local';
  const skipReasonId = useId();
  const skipReason = skipBlocked
    ? "We can't identify a single bundle to remove — try Rescue or Apply anyway."
    : undefined;
  // Disable rescue if: parent busy, this template's cap is spent (own
  // rescueAttempted flag or local rescued/rescue-failed state), OR any
  // OTHER template's rescue is in flight (Fix 2 — prevent concurrent
  // server-side cap consumption across templates).
  const rescueDisabled = busy || conflict.rescueAttempted || state.kind === 'rescuing'
    || state.kind === 'rescued' || state.kind === 'rescue-failed'
    || anyRescueInFlight;

  if (state.kind === 'skipped') {
    return (
      <div
        className={`${styles.conflictCallout} ${styles.collapsedConflict}`}
        data-conflict={conflict.templateName}
      >
        <span className={styles.collapsedText}>
          Skipped — these changes will not apply.
        </span>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={onReset}
          disabled={busy}
        >
          Undo
        </button>
      </div>
    );
  }

  if (state.kind === 'acceptedUnsat') {
    return (
      <div
        className={`${styles.conflictCallout} ${styles.collapsedConflict}`}
        data-conflict={conflict.templateName}
      >
        <span className={styles.collapsedText}>
          Will apply, leaves template unsatisfiable.
        </span>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={onReset}
          disabled={busy}
        >
          Undo
        </button>
      </div>
    );
  }

  if (state.kind === 'rescued') {
    return (
      <div
        className={`${styles.conflictCallout} ${styles.collapsedConflict}`}
        data-conflict={conflict.templateName}
      >
        <span className={styles.collapsedText}>
          Rescued — new option added to keep &quot;{conflict.templateName}&quot; usable.
        </span>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={onReset}
          disabled={busy}
        >
          Remove rescue
        </button>
      </div>
    );
  }

  return (
    <div className={styles.conflictCallout} data-conflict={conflict.templateName}>
      <div className={styles.conflictHeader}>
        <I.alert />
        <h4 className={styles.conflictTitle}>
          Template &quot;{conflict.templateName}&quot; would have no working combinations.
        </h4>
      </div>
      <p className={styles.conflictReason}>{conflict.reason}</p>
      {skipReason ? <p id={skipReasonId} className={styles.conflictReason}>{skipReason}</p> : null}
      {state.kind === 'rescue-failed' ? (
        <>
          <p className={styles.conflictReason}>Rescue failed: {state.reason}</p>
          <div className={styles.conflictActions}>
            <button
              type="button"
              className={btn.secondary}
              onClick={onSkip}
              disabled={busy || skipBlocked}
              aria-describedby={skipReason ? skipReasonId : undefined}
              data-tip={skipReason}
            >
              Skip these changes
            </button>
            <button
              type="button"
              className={btn.secondary}
              onClick={onAcceptUnsat}
              disabled={busy}
            >
              Apply anyway for this template
            </button>
          </div>
        </>
      ) : (
        <div className={styles.conflictActions}>
          <button
            type="button"
            className={btn.primary}
            onClick={onStartRescue}
            disabled={rescueDisabled}
          >
            {state.kind === 'rescuing' ? 'Rescuing…' : 'Rescue with AI'}
          </button>
          <button
            type="button"
            className={btn.secondary}
            onClick={onSkip}
            disabled={busy || skipBlocked || state.kind === 'rescuing'}
            aria-describedby={skipReason ? skipReasonId : undefined}
            data-tip={skipReason}
          >
            Skip these changes
          </button>
          <button
            type="button"
            className={btn.secondary}
            onClick={onAcceptUnsat}
            disabled={busy || state.kind === 'rescuing'}
          >
            Apply anyway for this template
          </button>
        </div>
      )}
    </div>
  );
}

export default function DimensionProposal({ data, applyCoherenceFailures, busy, onApply, onCancel }: Props) {
  const imageContext = usePromptImageContext();
  // Local lift of `bundles` and `conflicts` so a successful rescue can
  // append a new rescue bundle and the server's updated conflict list
  // (rescueAttempted=true) without us needing to call back into the hook.
  const [bundles, setBundles] = useState<readonly DimensionChangeBundle[]>(
    () => data.proposal.bundles,
  );
  const [conflicts, setConflicts] = useState<readonly TemplateConflict[]>(
    () => data.conflicts,
  );
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(data.proposal.bundles.filter((bundle) => bundle.defaultChecked).map((bundle) => bundle.key)),
  );
  const [conflictStates, setConflictStates] = useState<Map<string, ConflictState>>(
    () => {
      const map = new Map<string, ConflictState>();
      for (const c of data.conflicts) map.set(c.templateName, { kind: 'unresolved' });
      return map;
    },
  );
  const [acceptUnsat, setAcceptUnsat] = useState<Set<string>>(() => new Set());

  // SAFETY NET (commit 269403a): when the apply-time coherence check
  // flags templates the infer-time diagnosis didn't predict (because the
  // user's subset selection differs from the full-bundle scenario
  // diagnoseTemplateConflicts saw), merge them into the local conflicts
  // state so per-template Skip / Apply-anyway controls surface inline.
  // Rescue is greyed for these entries because they're not in
  // stored.conflicts on the server — /rescue would 404.
  //
  // With the live /diagnose-selection query wired above, this path
  // should never fire — diagnose runs reactively on every selection
  // change, so apply-422 surfaces only when the user clicks Apply while
  // a diagnose is still in flight (race condition). Keep it as defensive
  // code; remove only after a deployment proves zero apply-422 events
  // across all users for a sustained window.
  //
  // setState-during-render with a `prevApplyFailures` guard is the React
  // canonical pattern for "synchronize state to prop change" — preferred
  // over useEffect + setState which React Compiler flags as a cascade.
  const [prevApplyFailures, setPrevApplyFailures] = useState<readonly string[] | undefined>(applyCoherenceFailures);
  if (applyCoherenceFailures !== prevApplyFailures) {
    setPrevApplyFailures(applyCoherenceFailures);
    if (applyCoherenceFailures && applyCoherenceFailures.length > 0) {
      setConflicts((prev) => {
        const known = new Set(prev.map((c) => c.templateName));
        const next: TemplateConflict[] = prev.slice();
        for (const name of applyCoherenceFailures) {
          if (known.has(name)) continue;
          next.push({
            templateName: name,
            reason: 'unsatisfiable under your current selection — drop a bundle, or use “Apply anyway” to ship despite breakage',
            culpritBundleKeys: [],
            // rescueAttempted: true marks the inline-Rescue button as cap-spent
            // (greyed) — the conflict isn't in stored.conflicts server-side, so
            // /rescue would 404; honest UX rather than a guaranteed-error click.
            rescueAttempted: true,
            culpritKind: 'non-local',
          });
        }
        return next;
      });
      setConflictStates((prev) => {
        const next = new Map(prev);
        for (const name of applyCoherenceFailures) {
          if (!next.has(name)) next.set(name, { kind: 'unresolved' });
        }
        return next;
      });
    }
  }

  // Per-template abort controllers. Fix 2: a shared controller would let
  // user-clicked rescue on template B abort template A's in-flight request
  // AFTER the server has synchronously consumed A's one-shot cap, silently
  // burning it. Per-template controllers keep each request's lifetime
  // independent; concurrent fan-out is prevented globally by disabling all
  // Rescue buttons while ANY rescue is in flight (`anyRescueInFlight`).
  const rescueControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Rescued bundles join `bundles`, so grouping follows them.
  const groups = useMemo(() => buildDependencyGroups(bundles), [bundles]);
  const effective = useMemo(() => effectiveSelection(groups, picked), [groups, picked]);
  const selected = [...effective];

  // Live SAT recheck against the user's current selection. The infer-time
  // `data.conflicts` snapshot reasoned about the FULL bundle set; the
  // user's subset can either resolve those conflicts or introduce NEW
  // ones the original diagnosis didn't predict. Without this query the
  // user only learns about subset-introduced conflicts at apply-time via
  // the 422 fallback added in commit 269403a.
  //
  // We key off the EFFECTIVE picked set (after closure derivation): the
  // server's bundleClosure walk would yield the same chosen set whether
  // we send `picked` or `effective`, so sending `effective` collapses
  // identical-outcome selections into one cache key. Sorted for stable
  // key identity (Sets don't memoize by value).
  //
  // Debounce rapid checkbox toggles into the query key so quick local
  // selection edits issue one diagnose request for the settled set.
  const effectiveKey = useMemo(() => [...effective].sort(), [effective]);
  const deferredEffectiveKey = useDebouncedValue(effectiveKey, 250);
  const diagnoseQuery = useQuery(
    diagnoseSelectionOpts(data.proposalId, deferredEffectiveKey, !busy && data.proposalId.length > 0),
  );

  // Reconcile server-returned conflicts into the local conflicts +
  // conflictStates structures. setState-during-render with a state guard
  // (NOT a ref — React lints ref reads during render) is the canonical
  // "synchronize derived state from a changing input" pattern, same
  // shape as the applyCoherenceFailures merge below, preferred over
  // useEffect (React Compiler flags effect-driven state cascades).
  const [prevServerConflicts, setPrevServerConflicts] = useState<readonly TemplateConflict[] | null>(null);
  const serverConflicts = diagnoseQuery.data?.conflicts;
  if (serverConflicts !== undefined && serverConflicts !== prevServerConflicts) {
    setPrevServerConflicts(serverConflicts);
    const serverByName = new Map(serverConflicts.map((c) => [c.templateName, c] as const));
    setConflicts((prev) => {
      // Merge: keep existing entries (preserve rescueAttempted, refresh
      // culpritKind / culpritBundleKeys / reason from the server because
      // the subset selection may have shifted them); add new entries the
      // local state didn't know about; drop entries the server no longer
      // reports.
      const next: TemplateConflict[] = [];
      for (const local of prev) {
        const sv = serverByName.get(local.templateName);
        if (!sv) continue; // resolved — drop
        next.push({
          ...sv,
          // Server already merges the proposal's rescueAttempted, but
          // defensively OR with the local flag so a freshly-spent cap
          // (set client-side just before this reconciliation pass)
          // survives the merge.
          rescueAttempted: sv.rescueAttempted || local.rescueAttempted,
        });
      }
      const known = new Set(next.map((c) => c.templateName));
      for (const sv of serverConflicts) {
        if (!known.has(sv.templateName)) next.push(sv);
      }
      return next;
    });
    setConflictStates((prev) => {
      const next = new Map(prev);
      for (const sv of serverConflicts) {
        if (!next.has(sv.templateName)) next.set(sv.templateName, { kind: 'unresolved' });
      }
      // Drop states for templates the server no longer flags.
      for (const name of Array.from(next.keys())) {
        if (!serverByName.has(name)) next.delete(name);
      }
      return next;
    });
    // Drop acceptUnsat entries for templates the server no longer flags
    // (otherwise a stale `acceptUnsatisfiableTemplates: [name]` would be
    // sent on apply, and the server's filter would log a noisy warning).
    setAcceptUnsat((prev) => {
      let mutated = false;
      const next = new Set<string>();
      for (const name of prev) {
        if (serverByName.has(name)) {
          next.add(name);
        } else {
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
  }
  // Fix 2: globally serialize rescue clicks. While any template's rescue
  // is in flight, every other template's Rescue button is disabled so we
  // never fan out two concurrent rescues — each of which spends the cap
  // synchronously inside `beginRescueAttempt` on the server.
  const anyRescueInFlight = useMemo(() => {
    for (const state of conflictStates.values()) {
      if (state.kind === 'rescuing') return true;
    }
    return false;
  }, [conflictStates]);
  const skipped = data.rejected.reduce((sum, item) => sum + item.count, 0);
  const grouped = {
    regular: bundles.filter((bundle) => bundle.kind === 'create' || bundle.kind === 'extend'),
    reconcile: bundles.filter((bundle) => bundle.kind === 'merge' || bundle.kind === 'rename'),
    rescue: bundles.filter((bundle) => bundle.kind === 'rescue'),
  };

  // Map bundle.key → templateNames that list it as a culprit. Used to
  // render the "Conflicts with <template>" badges on each bundle row.
  const culpritIndex = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of conflicts) {
      for (const key of c.culpritBundleKeys) {
        const list = map.get(key) ?? [];
        list.push(c.templateName);
        map.set(key, list);
      }
    }
    return map;
  }, [conflicts]);

  const toggle = useCallback((key: string) => {
    setPicked((current) => toggleGroup(groups, current, key));
  }, [groups]);

  const setStateFor = useCallback((templateName: string, state: ConflictState) => {
    setConflictStates((current) => {
      const next = new Map(current);
      next.set(templateName, state);
      return next;
    });
  }, []);

  // Conflict culprits move with their whole dependency group so Skip / Undo
  // never leave a cyclic group half-picked.
  const removeKeysFromPicked = useCallback((keys: readonly string[]) => {
    setPicked((current) => {
      const next = new Set(current);
      for (const k of expandToGroups(groups, keys)) next.delete(k);
      return next;
    });
  }, [groups]);

  const addKeysToPicked = useCallback((keys: readonly string[]) => {
    setPicked((current) => {
      const next = new Set(current);
      for (const k of expandToGroups(groups, keys)) next.add(k);
      return next;
    });
  }, [groups]);

  const handleSkip = useCallback((conflict: TemplateConflict) => {
    const prev = conflictStates.get(conflict.templateName) ?? { kind: 'unresolved' };
    const next = conflictReducer(prev, { type: 'skip' });
    if (next === prev) return;
    const intent = intentFor(prev, next);
    setStateFor(conflict.templateName, next);
    if (intent.removeCulpritsFromPickedSet) {
      removeKeysFromPicked(conflict.culpritBundleKeys);
    }
    // If we were previously in acceptedUnsat, skip should also clear that.
    if (prev.kind === 'acceptedUnsat') {
      setAcceptUnsat((current) => {
        const out = new Set(current);
        out.delete(conflict.templateName);
        return out;
      });
    }
  }, [conflictStates, removeKeysFromPicked, setStateFor]);

  const handleAcceptUnsat = useCallback((conflict: TemplateConflict) => {
    const prev = conflictStates.get(conflict.templateName) ?? { kind: 'unresolved' };
    const next = conflictReducer(prev, { type: 'acceptUnsat' });
    if (next === prev) return;
    const intent = intentFor(prev, next);
    setStateFor(conflict.templateName, next);
    if (intent.addToAcceptUnsat) {
      setAcceptUnsat((current) => {
        const out = new Set(current);
        out.add(conflict.templateName);
        return out;
      });
    }
    // If we were in skipped, re-add culprits so the user's "apply anyway"
    // genuinely includes the culprit bundles (otherwise it would skip them
    // silently and the template would remain non-broken-but-empty).
    if (prev.kind === 'skipped') {
      addKeysToPicked(conflict.culpritBundleKeys);
    }
  }, [addKeysToPicked, conflictStates, setStateFor]);

  const handleStartRescue = useCallback(async (conflict: TemplateConflict) => {
    const prev = conflictStates.get(conflict.templateName) ?? { kind: 'unresolved' };
    const next = conflictReducer(prev, { type: 'startRescue' });
    if (next === prev) return;
    const intent = intentFor(prev, next);
    setStateFor(conflict.templateName, next);
    if (intent.recheckCulpritsInPickedSet) {
      addKeysToPicked(conflict.culpritBundleKeys);
    }
    if (intent.removeFromAcceptUnsat) {
      setAcceptUnsat((current) => {
        const out = new Set(current);
        out.delete(conflict.templateName);
        return out;
      });
    }

    // Fix 2: per-template controller — never abort another template's
    // request. The previous shared-controller implementation could abort
    // request A after the server had synchronously consumed A's one-shot
    // cap, leaving the user with a spent cap and no committed bundle.
    const controllers = rescueControllersRef.current;
    controllers.get(conflict.templateName)?.abort(new DOMException('superseded', 'AbortError'));
    const controller = new AbortController();
    controllers.set(conflict.templateName, controller);
    try {
      const result = await rescueDimension(
        { proposalId: data.proposalId, templateName: conflict.templateName, ...imageContext },
        controller.signal,
      );
      if (result.type === 'ok') {
        setBundles((current) => [...current, result.rescueBundle]);
        setConflicts(result.conflicts);
        // A fresh rescue key has no dependents yet, so it is always its
        // own selection group; adding the key alone is complete.
        setPicked((current) => {
          const out = new Set(current);
          out.add(result.rescueBundle.key);
          return out;
        });
        setStateFor(conflict.templateName, {
          kind: 'rescued',
          rescueBundleKey: result.rescueBundle.key,
        });
      } else {
        // Fix 3 (client): server-side Fix 3 now sends the updated
        // conflicts snapshot on rescue-failed (rescueAttempted=true on the
        // matching entry). Replace local conflicts so the reset → Rescue
        // cycle correctly sees a cap-spent flag downstream.
        if (result.conflicts.length > 0) {
          setConflicts(result.conflicts);
        }
        setStateFor(conflict.templateName, { kind: 'rescue-failed', reason: result.reason });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'rescue failed';
      setStateFor(conflict.templateName, { kind: 'rescue-failed', reason: message });
    } finally {
      // Only clear our slot if it's still ours — a concurrent abort
      // (shouldn't happen with per-template controllers, but defensive)
      // could have replaced it.
      if (controllers.get(conflict.templateName) === controller) {
        controllers.delete(conflict.templateName);
      }
    }
  }, [addKeysToPicked, conflictStates, data.proposalId, imageContext, setStateFor]);

  const handleReset = useCallback((conflict: TemplateConflict) => {
    const prev = conflictStates.get(conflict.templateName) ?? { kind: 'unresolved' };
    // M3: Remove rescue from a rescued state would otherwise transition to
    // unresolved while the culprit bundles are STILL picked — Apply then
    // 422s ("would make template unsatisfiable") with no recovery affordance.
    // Auto-Skip the culprits and transition to skipped so the collapsed
    // "Skipped" callout + Undo is the recovery path. Cap is still spent on
    // the server, so handleStartRescue's reducer still rejects re-rescue.
    if (prev.kind === 'rescued') {
      setBundles((current) => current.filter((b) => b.key !== prev.rescueBundleKey));
      setPicked((current) => {
        const out = new Set(current);
        out.delete(prev.rescueBundleKey);
        for (const k of expandToGroups(groups, conflict.culpritBundleKeys)) out.delete(k);
        return out;
      });
      setStateFor(conflict.templateName, { kind: 'skipped' });
      return;
    }
    // Undo any sideways effects that the prior state applied.
    if (prev.kind === 'skipped') {
      addKeysToPicked(conflict.culpritBundleKeys);
    }
    if (prev.kind === 'acceptedUnsat') {
      setAcceptUnsat((current) => {
        const out = new Set(current);
        out.delete(conflict.templateName);
        return out;
      });
    }
    setStateFor(conflict.templateName, { kind: 'unresolved' });
  }, [addKeysToPicked, conflictStates, groups, setStateFor]);

  const scrollToConflict = useCallback((templateName: string) => {
    // Fix 5: template names are user-controlled and only trimmed +
    // length-limited server-side. Interpolating into a CSS attribute
    // selector throws DOMException on names containing quotes, brackets,
    // or selector metacharacters. Side-step the parser entirely by
    // matching on the attribute presence and comparing the raw value via
    // getAttribute — no escaping rules to get wrong.
    const candidates = document.querySelectorAll<HTMLElement>('[data-conflict]');
    for (const el of candidates) {
      if (el.getAttribute('data-conflict') === templateName) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
    }
  }, []);

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>AI proposal</p>
          <h3>{bundles.length} changes from snapshot {data.baseSnapshotHash}</h3>
        </div>
      </header>
      {conflicts.length > 0 ? (
        <div className={styles.conflictGroup}>
          {conflicts.map((conflict) => (
            <ConflictCallout
              key={conflict.templateName}
              conflict={conflict}
              state={conflictStates.get(conflict.templateName) ?? { kind: 'unresolved' }}
              busy={busy}
              anyRescueInFlight={anyRescueInFlight}
              onSkip={() => { handleSkip(conflict); }}
              onAcceptUnsat={() => { handleAcceptUnsat(conflict); }}
              onStartRescue={() => { void handleStartRescue(conflict); }}
              onReset={() => { handleReset(conflict); }}
            />
          ))}
        </div>
      ) : null}
      {data.notices && data.notices.length > 0 ? (
        <div className={styles.warning} role="status">
          {data.notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      ) : null}
      {data.warnings.length > 0 ? (
        <div className={styles.warning}>
          {data.warnings.map((warning) => (
            <p key={`${warning.templateName}:${warning.detail}`}>
              <strong>{warning.templateName}:</strong> {warning.detail}
            </p>
          ))}
        </div>
      ) : null}
      {data.coverage.length > 0 ? (
        <div className={styles.warning}>
          <p>
            <strong>Coverage gap</strong> — these wildcards will roll into incongruous combinations. Re-run the AI to fill them in.
          </p>
          {data.coverage.map((warning) => {
            const key = warning.kind === 'orphanTag'
              ? `orphan:${warning.dim}:${warning.label}`
              : warning.kind === 'lowCoverage'
                ? `low:${warning.listName}:${warning.dim}`
                : `missing:${warning.listName}:${warning.dim}`;
            return <p key={key}>{warning.detail}</p>;
          })}
        </div>
      ) : null}
      <Section
        heading="New / Extend"
        bundles={grouped.regular}
        groups={groups}
        effective={effective}
        busy={busy}
        onToggle={toggle}
        culpritIndex={culpritIndex}
        onBadgeClick={scrollToConflict}
      />
      <Section
        heading="Reconcile"
        bundles={grouped.reconcile}
        groups={groups}
        effective={effective}
        busy={busy}
        onToggle={toggle}
        culpritIndex={culpritIndex}
        onBadgeClick={scrollToConflict}
      />
      <Section
        heading="AI rescue"
        bundles={grouped.rescue}
        groups={groups}
        effective={effective}
        busy={busy}
        onToggle={toggle}
        culpritIndex={culpritIndex}
        onBadgeClick={scrollToConflict}
      />
      {skipped > 0 ? (
        <p className={styles.skipped}>
          {skipped} suggestion(s) skipped -- {data.rejected.map((item) => `${item.reason} (${item.count})`).join(', ')}
        </p>
      ) : null}
      <footer className={styles.footer}>
        {diagnoseQuery.isFetching ? (
          <span className={styles.recheck} role="status" aria-live="polite">Re-checking…</span>
        ) : null}
        <button type="button" className={btn.secondary} onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className={btn.primary}
          onClick={() => { onApply(selected, [...acceptUnsat]); }}
          disabled={busy}
          aria-busy={diagnoseQuery.isFetching}
        >
          Apply {selected.length} of {bundles.length}
        </button>
      </footer>
    </div>
  );
}
