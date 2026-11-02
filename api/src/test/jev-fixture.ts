import { setJevSystemOneProviderForTests } from '../providers/jevSystemOne';

/** Existing transport suites exercise GPT responses after an allowed check. */
export function allowJevForProviderTests(): void {
  setJevSystemOneProviderForTests(() => Promise.resolve(Response.json({ answers: {
    explicit_nudity: { type: 'noul', noul: 0.01 },
    sexual_minor_or_unknown_age: { type: 'noul', noul: 0.01 },
    graphic_violence: { type: 'noul', noul: 0.01 },
  } })));
}

export function resetJevForProviderTests(): void {
  setJevSystemOneProviderForTests(null);
}
