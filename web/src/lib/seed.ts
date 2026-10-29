// A fresh 32-bit unsigned seed for the prompt resolver's RNG. Each call draws
// from crypto so successive Generate/re-roll actions pick independent branches.
export function nextSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] ?? 0;
}
