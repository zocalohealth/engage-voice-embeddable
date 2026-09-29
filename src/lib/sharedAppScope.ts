/** Worker URLs and reload channels must agree on which tabs share a configuration. */
export function sharedAppSearch(search: string): string {
  const params = new URLSearchParams(search);
  ['_t', 'fromAdapter', 'fromPopup'].forEach((key) => params.delete(key));
  params.sort();
  return params.toString();
}

export async function sharedAppScope(search: string): Promise<string> {
  // Query parameters can contain credentials; never expose them in channel names.
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(sharedAppSearch(search)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
