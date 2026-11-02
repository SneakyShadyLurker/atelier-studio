// Base-URL rule for admin-managed text providers. Shared by the api's zod
// schema and the web form so both reject the same input with the same words.
// Hostnames are deliberately unrestricted: localhost and private LAN addresses
// (Ollama, LM Studio, a proxy on another machine) are a supported setup, and
// only admins can trigger calls to a provider. Env-sourced URLs keep the
// stricter bare-origin rule in the api config.

export type TextProviderBaseUrlResult =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly message: string };

/**
 * Validates a provider base URL: `http:` or `https:` only, no user name or
 * password, no query, no fragment; a path prefix such as `/v1` is allowed.
 * Returns the URL normalized by the WHATWG parser with trailing slashes removed.
 */
export function validateTextProviderBaseUrl(input: string): TextProviderBaseUrlResult {
  const raw = input.trim();
  if (raw === '') return { ok: false, message: 'Enter the server address, for example http://localhost:11434/v1.' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'This is not a full web address. Start it with http:// or https://.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'The address must start with http:// or https://.' };
  }
  // An empty user name (`http://@host`) parses to '' too, so also look for `@`
  // in the raw authority.
  const authority = raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0] ?? '';
  if (url.username !== '' || url.password !== '' || authority.includes('@')) {
    return { ok: false, message: 'Remove the user name or password from the address. Put the key in the API key field instead.' };
  }
  // The parser drops an empty `?` or `#`, so check the raw text: in a URL these
  // characters can only start a query or a fragment.
  if (raw.includes('?') || url.search !== '') {
    return { ok: false, message: 'Remove the part after "?" from the address. Atelier adds its own request paths.' };
  }
  if (raw.includes('#') || url.hash !== '') {
    return { ok: false, message: 'Remove the part after "#" from the address.' };
  }

  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, normalized: `${url.protocol}//${url.host}${path}` };
}
