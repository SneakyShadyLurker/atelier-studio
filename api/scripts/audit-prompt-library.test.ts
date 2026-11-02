import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LibraryDiagnosisResponse, PromptLibraryResponse, TagDimension, VariableList } from '@atelier/shared';
import { auditFillBoundaries, auditManualOnlyOptions, auditNodeBudgetOverride, auditTagHygiene, auditUserId, computeExitCodeFromDiagnosis, diagnoseLibraryForAudit, format, formatManualOnly, isLikelyLiveDbPath, verifyUserExists } from './audit-prompt-library';
import { diagnoseLibrary, DIAGNOSIS_NODE_BUDGET } from '../src/prompts/libraryDiagnosis';

describe('audit-prompt-library', () => {
  test('requires ATELIER_USER_ID explicitly, with no default user', () => {
    expect(auditUserId({})).toBeNull();
    expect(auditUserId({ ATELIER_USER_ID: ' ' })).toBeNull();
    expect(auditUserId({ ATELIER_USER_ID: 'alice' })).toBe('alice');
  });

  test('returns 0 when every template is satisfiable', () => {
    const diag: LibraryDiagnosisResponse = {
      templates: [
        { templateName: 'A', satisfiable: true },
        { templateName: 'B', satisfiable: true },
      ],
      librarySnapshotHash: 'x',
      templatesDigest: 'y',
    };
    expect(computeExitCodeFromDiagnosis(diag)).toBe(0);
  });

  test('returns 1 when any template is unsatisfiable', () => {
    const diag: LibraryDiagnosisResponse = {
      templates: [
        { templateName: 'A', satisfiable: true },
        { templateName: 'B', satisfiable: false },
      ],
      librarySnapshotHash: 'x',
      templatesDigest: 'y',
    };
    expect(computeExitCodeFromDiagnosis(diag)).toBe(1);
  });

  test('returns 0 when there are no templates at all', () => {
    const diag: LibraryDiagnosisResponse = {
      templates: [],
      librarySnapshotHash: 'x',
      templatesDigest: 'y',
    };
    expect(computeExitCodeFromDiagnosis(diag)).toBe(0);
  });

  test('separates inconclusive checks from proven failures and returns incomplete exit 5', () => {
    const diag: LibraryDiagnosisResponse = {
      templates: [{ templateName: 'Unknown', satisfiable: null, reason: 'diagnosis budget exceeded' }, { templateName: 'OK', satisfiable: true }],
      librarySnapshotHash: 'x', templatesDigest: 'y',
    };
    expect(computeExitCodeFromDiagnosis(diag)).toBe(5);
    expect(format(diag)).toContain('BROKEN (0/2)');
    expect(format(diag)).toContain('INCOMPLETE (1/2)\n  - Unknown — diagnosis budget exceeded');
    const mixed = { ...diag, templates: [...diag.templates, { templateName: 'Broken', satisfiable: false, reason: 'missing list' }] };
    expect(computeExitCodeFromDiagnosis(mixed)).toBe(1);
    expect(format(mixed)).toContain('BROKEN (1/3)\n  - Broken — missing list');
    expect(format(mixed)).toContain('INCOMPLETE (1/3)');
  });

  test('validates positive safe-integer budget overrides without changing an omitted value', () => {
    expect(auditNodeBudgetOverride({})).toBeUndefined();
    for (const value of ['1', '200000', String(Number.MAX_SAFE_INTEGER)]) {
      expect(auditNodeBudgetOverride({ ATELIER_AUDIT_NODE_BUDGET: value })).toBe(Number(value));
    }
    for (const value of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1), 'nope']) {
      expect(() => auditNodeBudgetOverride({ ATELIER_AUDIT_NODE_BUDGET: value }))
        .toThrow('ATELIER_AUDIT_NODE_BUDGET must be a positive safe integer');
    }
  });

  test('a bad budget override exits as a configuration error before opening the DB', async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/audit-prompt-library.ts`], {
      env: { ...process.env, ATELIER_USER_ID: 'alice', ATELIER_DB_PATH: '/missing/audit-test.sqlite', ATELIER_AUDIT_NODE_BUDGET: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      expect(await child.exited).toBe(3);
      expect(await new Response(child.stderr).text()).toContain('ATELIER_AUDIT_NODE_BUDGET must be a positive safe integer');
    } finally { child.kill(); }
  });

  test('offline diagnosis scales the shared default and honors a tiny explicit total budget', () => {
    const lib: PromptLibraryResponse = {
      templates: Array.from({ length: 30 }, (_, i) => ({
        id: `t-${i}`, name: `Template ${i}`, body: '{{var::A}} {{var::B}}', sortOrder: i, createdAt: 0, updatedAt: 0,
      })),
      variableLists: ['A', 'B'].map((name, listIdx) => ({
        id: name, name, sortOrder: listIdx, createdAt: 0, updatedAt: 0,
        options: Array.from({ length: 100 }, (_, i) => ({
          id: `${name}-${i}`, listId: name, value: String(i), sortOrder: i, weight: 1, tagIds: [`tag-${listIdx}`],
        })),
      })),
      dimensions: [{ id: 'd', name: 'D', tags: [0, 1].map((i) => ({
        id: `tag-${i}`, dimensionId: 'd', label: String(i), sortOrder: i,
      })) }],
    };
    const boundedHttp = diagnoseLibrary(lib, { totalBudget: DIAGNOSIS_NODE_BUDGET });
    expect(boundedHttp.templates.some((entry) => entry.satisfiable === null)).toBe(true);
    const offline = diagnoseLibraryForAudit(lib);
    expect(offline.templates.every((entry) => entry.satisfiable === false)).toBe(true);
    expect(computeExitCodeFromDiagnosis(offline)).toBe(1);
    const tiny = diagnoseLibraryForAudit(lib, auditNodeBudgetOverride({ ATELIER_AUDIT_NODE_BUDGET: '1' }));
    expect(tiny.templates.every((entry) => entry.satisfiable === null)).toBe(true);
    expect(computeExitCodeFromDiagnosis(tiny)).toBe(5);
    // Cheap templates must not donate their default offline allowance to a
    // pathological solver template. An explicit total override may raise it.
    const mixed = {
      ...lib,
      templates: lib.templates.map((template, i) => i === 0 ? template : { ...template, body: '{{var::A}}' }),
      variableLists: lib.variableLists.map((list, listIdx) => ({
        ...list, options: Array.from({ length: 500 }, (_, i) => ({
          id: `${list.name}-${i}`, listId: list.id, value: String(i), sortOrder: i, weight: 1, tagIds: [`tag-${listIdx}`],
        })),
      })),
    };
    expect(diagnoseLibraryForAudit(mixed).templates[0]?.satisfiable).toBeNull();
    expect(diagnoseLibraryForAudit(mixed, DIAGNOSIS_NODE_BUDGET * mixed.templates.length).templates[0]?.satisfiable).toBe(false);
  });
});

describe('verifyUserExists', () => {
  test('returns ok:true when the user row exists', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.run("INSERT INTO users VALUES ('alice')");

    const result = verifyUserExists(db, 'alice');
    expect(result.ok).toBe(true);

    db.close();
  });

  test('returns ok:false with descriptive reason when user is missing', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id TEXT PRIMARY KEY)');

    const result = verifyUserExists(db, 'ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('ghost');
      expect(result.reason).toContain('ATELIER_USER_ID');
    }

    db.close();
  });
});

describe('auditTagHygiene', () => {
  // Build a one-list, one-dimension library. `optionTags` maps option value → tag labels.
  function mkLib(listName: string, dimName: string, labels: readonly string[], optionTags: Record<string, readonly string[]>): PromptLibraryResponse {
    const dimId = `dim-${dimName}`;
    const tagId = (label: string) => `tag-${dimName}-${label}`;
    const dimension: TagDimension = {
      id: dimId,
      name: dimName,
      tags: labels.map((label, i) => ({ id: tagId(label), dimensionId: dimId, label, sortOrder: i })),
    };
    const list: VariableList = {
      id: 'list-1',
      name: listName,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      options: Object.entries(optionTags).map(([value, tags], i) => ({
        id: `opt-${i}`,
        listId: 'list-1',
        value,
        tagIds: tags.map(tagId),
        sortOrder: i,
        weight: 1,
      })),
    };
    return { templates: [], variableLists: [list], dimensions: [dimension] };
  }

  test('flags a fully-tagged list with no universal value (dead-option risk)', () => {
    // Mirrors the fantasy_franchise / Cthulhu bug: every option tagged, but the
    // minority lacks the dominant value.
    const lib = mkLib('fantasy_franchise', 'Genre', ['Fantasy', 'Horror'], {
      'The Witcher': ['Fantasy'],
      'Dragon Age': ['Fantasy'],
      'Cthulhu Mythos': ['Horror'],
    });
    const warnings = auditTagHygiene(lib);
    const w = warnings.find((x) => x.kind === 'non-universal-in-full-list');
    expect(w).toBeDefined();
    expect(w?.dimensionName).toBe('Genre');
    expect(w?.optionValues).toEqual(['Cthulhu Mythos']);
  });

  test('does NOT flag a fully-tagged list that shares a universal value', () => {
    const lib = mkLib('fantasy_pose', 'Genre', ['Fantasy', 'Horror'], {
      'kneeling': ['Fantasy'],
      'reaching': ['Fantasy', 'Horror'],
      'standing': ['Fantasy'],
    });
    expect(auditTagHygiene(lib)).toEqual([]);
  });

  test('flags sparse tags (the stray-tag / face pattern)', () => {
    const lib = mkLib('face', 'Genre', ['Modern Earth'], {
      'face a': [],
      'face b': [],
      'face c': [],
      'face d': [],
      'nerdy face': ['Modern Earth'],
    });
    const warnings = auditTagHygiene(lib);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('sparse-tags');
    expect(warnings[0]?.optionValues).toEqual(['nerdy face']);
  });

  test('does NOT flag a non-siloing (identity/spread) dimension with no universal', () => {
    // Fantasy Race is an identity dimension: each race carries its OWN value, so
    // "no universal" is correct and must not be reported.
    const lib = mkLib('fantasy_race', 'Fantasy Race', ['High Elf', 'Dwarf', 'Orc'], {
      'high elf': ['High Elf'],
      'dwarf': ['Dwarf'],
      'orc': ['Orc'],
    });
    expect(auditTagHygiene(lib)).toEqual([]);
  });

  test('does NOT flag sparse tags on a non-siloing dimension', () => {
    const lib = mkLib('lighting', 'Daypart', ['late-night'], {
      'candlelit': ['late-night'],
      'daylight': [],
      'overhead': [],
      'flash': [],
    });
    expect(auditTagHygiene(lib)).toEqual([]);
  });

  test('does NOT flag a fully-untagged list', () => {
    const lib = mkLib('ethnicity', 'Genre', ['Modern Earth'], {
      'a': [],
      'b': [],
      'c': [],
    });
    expect(auditTagHygiene(lib)).toEqual([]);
  });

  test('excludes manual-only options from dead-option detection and reports them separately', () => {
    const lib = mkLib('fantasy_franchise', 'Genre', ['Fantasy', 'Horror'], {
      'The Witcher': ['Fantasy'],
      'Dragon Age': ['Fantasy'],
      'Cthulhu Mythos': ['Horror'],
    });
    const manualLib: PromptLibraryResponse = {
      ...lib,
      variableLists: lib.variableLists.map((list) => ({
        ...list,
        options: list.options.map((option) =>
          option.value === 'Cthulhu Mythos' ? { ...option, weight: 0 } : option,
        ),
      })),
    };

    expect(auditTagHygiene(manualLib)).toEqual([]);
    const notes = auditManualOnlyOptions(manualLib);
    expect(notes).toEqual([{ listName: 'fantasy_franchise', optionValues: ['Cthulhu Mythos'] }]);
    expect(formatManualOnly(notes)).toContain('MANUAL ONLY (1 option)');
    expect(formatManualOnly(notes)).toContain('Cthulhu Mythos');
  });

  test('reports polarity overlap, parent cycles, depth above 8, and cross-dimension parents', () => {
    const deepTags: TagDimension['tags'] = Array.from({ length: 9 }, (_value, index) => ({
      id: `deep-${index}`,
      dimensionId: 'hierarchy',
      label: `Deep ${index}`,
      sortOrder: index + 3,
      ...(index === 0 ? {} : { parentId: `deep-${index - 1}` }),
    }));
    const lib: PromptLibraryResponse = {
      templates: [],
      dimensions: [
        {
          id: 'hierarchy',
          name: 'Hierarchy',
          tags: [
            { id: 'cross', dimensionId: 'hierarchy', label: 'Cross', sortOrder: 0, parentId: 'foreign-parent' },
            { id: 'cycle-a', dimensionId: 'hierarchy', label: 'Cycle A', sortOrder: 1, parentId: 'cycle-b' },
            { id: 'cycle-b', dimensionId: 'hierarchy', label: 'Cycle B', sortOrder: 2, parentId: 'cycle-a' },
            ...deepTags,
          ],
        },
        {
          id: 'foreign',
          name: 'Foreign',
          tags: [{ id: 'foreign-parent', dimensionId: 'foreign', label: 'Foreign parent', sortOrder: 0 }],
        },
      ],
      variableLists: [{
        id: 'list',
        name: 'list',
        sortOrder: 0,
        createdAt: 0,
        updatedAt: 0,
        options: [{
          id: 'option',
          listId: 'list',
          value: 'overlap',
          tagIds: ['cycle-a'],
          excludeTagIds: ['cycle-a'],
          sortOrder: 0,
          weight: 1,
        }],
      }],
    };

    const kinds = new Set(auditTagHygiene(lib).map((warning) => warning.kind));
    expect(kinds).toContain('same-tag-require-exclude');
    expect(kinds).toContain('parent-cycle');
    expect(kinds).toContain('hierarchy-too-deep');
    expect(kinds).toContain('cross-dimension-parent');
  });

  test('reports require-child and exclude-parent as the same-tag hygiene conflict', () => {
    const lib: PromptLibraryResponse = {
      templates: [],
      dimensions: [{ id: 'd', name: 'Hierarchy', tags: [
        { id: 'parent', dimensionId: 'd', label: 'Parent', sortOrder: 0 },
        { id: 'child', dimensionId: 'd', label: 'Child', sortOrder: 1, parentId: 'parent' },
      ] }],
      variableLists: [{
        id: 'list', name: 'list', sortOrder: 0, createdAt: 0, updatedAt: 0,
        options: [{
          id: 'option', listId: 'list', value: 'invalid', tagIds: ['child'],
          excludeTagIds: ['parent'], sortOrder: 0, weight: 1,
        }],
      }],
    };

    const warning = auditTagHygiene(lib).find((candidate) => (
      candidate.kind === 'same-tag-require-exclude'
    ));
    expect(warning?.kind).toBe('same-tag-require-exclude');
    expect(warning?.optionValues).toEqual(['invalid']);
  });
});

describe('isLikelyLiveDbPath', () => {
  test('matches /data/atelier.sqlite (container volume path)', () => {
    expect(isLikelyLiveDbPath('/data/atelier.sqlite')).toBe(true);
  });

  test('matches docker atelier-data path', () => {
    expect(isLikelyLiveDbPath('/srv/atelier-data/atelier.sqlite')).toBe(true);
  });

  test('does not match a temp or test path', () => {
    expect(isLikelyLiveDbPath('/tmp/test.sqlite')).toBe(false);
    expect(isLikelyLiveDbPath('/var/data/other.sqlite')).toBe(false);
  });
});

describe('auditFillBoundaries', () => {
  // Multi-list, one-dimension library with a single template body.
  // `lists` maps list name → option value → tag labels on the dimension.
  function mkLib(
    dimName: string,
    labels: readonly string[],
    lists: Record<string, Record<string, readonly string[]>>,
    body: string,
  ): PromptLibraryResponse {
    const dimId = `dim-${dimName}`;
    const tagId = (label: string) => `tag-${dimName}-${label}`;
    const dimension: TagDimension = {
      id: dimId,
      name: dimName,
      tags: labels.map((label, i) => ({ id: tagId(label), dimensionId: dimId, label, sortOrder: i })),
    };
    const variableLists: VariableList[] = Object.entries(lists).map(([name, options], li) => ({
      id: `list-${li}`,
      name,
      options: Object.entries(options).map(([value, tags], oi) => ({
        id: `opt-${li}-${oi}`,
        listId: `list-${li}`,
        value,
        tagIds: tags.map(tagId),
        sortOrder: oi,
        weight: 1,
      })),
      sortOrder: li,
      createdAt: 0,
      updatedAt: 0,
    }));
    return {
      templates: [{ id: 't-1', name: 'T', body, sortOrder: 0, createdAt: 0, updatedAt: 0 }],
      variableLists,
      dimensions: [dimension],
    };
  }

  const RACES = { Klingon: ['Trek'], Sith: ['Wars'] };
  const FRANCHISES = { 'Star Trek': ['Trek'], 'Star Wars': ['Wars'] };

  test('warns when a non-vacuous tagged pair straddles a fill boundary', () => {
    const lib = mkLib('Franchise', ['Trek', 'Wars'], { race: RACES, franchise: FRANCHISES },
      'from {{var::franchise}}. {{ai-fill: render a {{var::race}} woman}}');
    const warnings = auditFillBoundaries(lib);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.dimensionName).toBe('Franchise');
    expect([warnings[0]?.listA, warnings[0]?.listB].sort()).toEqual(['franchise', 'race']);
  });

  test('does NOT warn when both slots share one context (same instruction)', () => {
    const lib = mkLib('Franchise', ['Trek', 'Wars'], { race: RACES, franchise: FRANCHISES },
      'a frame. {{ai-fill: render a {{var::race}} woman from {{var::franchise}}}}');
    expect(auditFillBoundaries(lib)).toEqual([]);
  });

  test('does NOT warn when both slots are static', () => {
    const lib = mkLib('Franchise', ['Trek', 'Wars'], { race: RACES, franchise: FRANCHISES },
      'from {{var::franchise}}, a {{var::race}} woman. {{ai-fill: a pose}}');
    expect(auditFillBoundaries(lib)).toEqual([]);
  });

  test('does NOT warn on a vacuous (blanket same-label) cross-boundary pair', () => {
    const lib = mkLib('Genre', ['Fantasy'],
      { atmosphere: { calm: ['Fantasy'], tense: ['Fantasy'] }, franchise: { LOTR: ['Fantasy'], Conan: ['Fantasy'] } },
      'in {{var::atmosphere}}. {{ai-fill: from {{var::franchise}}}}');
    expect(auditFillBoundaries(lib)).toEqual([]);
  });

  test('does NOT warn when the in-fill list is untagged', () => {
    const lib = mkLib('Franchise', ['Trek', 'Wars'], { face: { soft: [], sharp: [] }, franchise: FRANCHISES },
      'from {{var::franchise}}. {{ai-fill: with {{var::face}}}}');
    expect(auditFillBoundaries(lib)).toEqual([]);
  });

  test('warns across two different fills, catching @N subject grammar too', () => {
    const lib = mkLib('Franchise', ['Trek', 'Wars'], { race: RACES, franchise: FRANCHISES },
      '{{ai-fill: from {{var::franchise@1}}}} and {{ai-fill: a {{var::race@1}} woman}}');
    const warnings = auditFillBoundaries(lib);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.contextA).toBe('fill #1');
    expect(warnings[0]?.contextB).toBe('fill #2');
  });

  test('dedupes a repeated pair to one warning', () => {
    const lib = mkLib('Franchise', ['Trek', 'Wars'], { race: RACES, franchise: FRANCHISES },
      'from {{var::franchise}} and {{var::franchise}}. {{ai-fill: a {{var::race}} woman, {{var::race}} again}}');
    expect(auditFillBoundaries(lib)).toHaveLength(1);
  });

  test('expands ancestors on exclude tags when detecting a cross-boundary constraint', () => {
    const lib: PromptLibraryResponse = {
      templates: [{
        id: 'template',
        name: 'T',
        body: '{{var::required}} {{ai-fill: {{var::excluded}}}}',
        sortOrder: 0,
        createdAt: 0,
        updatedAt: 0,
      }],
      dimensions: [{
        id: 'franchise',
        name: 'Franchise',
        tags: [
          { id: 'parent', dimensionId: 'franchise', label: 'Parent', sortOrder: 0 },
          { id: 'child', dimensionId: 'franchise', label: 'Child', sortOrder: 1, parentId: 'parent' },
        ],
      }],
      variableLists: [
        {
          id: 'required-list',
          name: 'required',
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
          options: [{ id: 'required-option', listId: 'required-list', value: 'required', tagIds: ['parent'], sortOrder: 0, weight: 1 }],
        },
        {
          id: 'excluded-list',
          name: 'excluded',
          sortOrder: 1,
          createdAt: 0,
          updatedAt: 0,
          options: [{
            id: 'excluded-option',
            listId: 'excluded-list',
            value: 'excluded',
            tagIds: [],
            excludeTagIds: ['child'],
            sortOrder: 0,
            weight: 1,
          }],
        },
      ],
    };

    expect(auditFillBoundaries(lib)).toHaveLength(1);
  });

  test('does NOT warn when the only cross-boundary conflict comes from a manual-only option', () => {
    const base = mkLib(
      'Franchise',
      ['Trek', 'Wars'],
      {
        race: { automatic: [], manual: [] },
        franchise: { 'Star Trek': ['Trek'] },
      },
      'from {{var::franchise}}. {{ai-fill: render a {{var::race}} woman}}',
    );
    const lib: PromptLibraryResponse = {
      ...base,
      variableLists: base.variableLists.map((list) => list.name !== 'race'
        ? list
        : {
            ...list,
            options: list.options.map((option) => option.value === 'manual'
              ? { ...option, weight: 0, excludeTagIds: ['tag-Franchise-Trek'] }
              : option),
          }),
    };

    expect(auditFillBoundaries(lib)).toEqual([]);
  });
});

describe('auditFillBoundaries — adversarial regressions', () => {
  function mkLib2(
    lists: Record<string, Record<string, readonly string[]>>,
    body: string,
  ): PromptLibraryResponse {
    const dimId = 'dim-Franchise';
    const tagId = (label: string) => `tag-Franchise-${label}`;
    const dimension: TagDimension = {
      id: dimId,
      name: 'Franchise',
      tags: ['Trek', 'Wars'].map((label, i) => ({ id: tagId(label), dimensionId: dimId, label, sortOrder: i })),
    };
    const variableLists: VariableList[] = Object.entries(lists).map(([name, options], li) => ({
      id: `list-${li}`,
      name,
      options: Object.entries(options).map(([value, tags], oi) => ({
        id: `opt-${li}-${oi}`,
        listId: `list-${li}`,
        value,
        tagIds: tags.map(tagId),
        sortOrder: oi,
        weight: 1,
      })),
      sortOrder: li,
      createdAt: 0,
      updatedAt: 0,
    }));
    return {
      templates: [{ id: 't-1', name: 'T', body, sortOrder: 0, createdAt: 0, updatedAt: 0 }],
      variableLists,
      dimensions: [dimension],
    };
  }
  const LISTS = { race: { Klingon: ['Trek'], Sith: ['Wars'] }, franchise: { 'Star Trek': ['Trek'], 'Star Wars': ['Wars'] } };

  test('a whitespace-padded subject token still resolves to its list (no false negative)', () => {
    const lib = mkLib2(LISTS, 'from {{var::franchise}}. {{ai-fill: render a {{var:: race @1 }} woman}}');
    const warnings = auditFillBoundaries(lib);
    expect(warnings).toHaveLength(1);
    expect([warnings[0]?.listA, warnings[0]?.listB].sort()).toEqual(['franchise', 'race']);
  });

  test('cross-subject pairs (@1 × @2) are unconstrained by construction — no false positive', () => {
    const lib = mkLib2(LISTS, 'from {{var::franchise@1}}. {{ai-fill: render a {{var::race@2}} woman}}');
    expect(auditFillBoundaries(lib)).toEqual([]);
  });

  test('scene-level (bare) slots bridge into subject groups across a boundary', () => {
    const lib = mkLib2(LISTS, 'from {{var::franchise}}. {{ai-fill: render a {{var::race@2}} woman}}');
    expect(auditFillBoundaries(lib)).toHaveLength(1);
  });
});
