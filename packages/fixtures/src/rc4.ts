/** RC4 stream cipher (only for synthesizing legacy-encrypted PDF fixtures). */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + (s[i] as number) + (key[i % key.length] as number)) & 0xff;
    const t = s[i] as number;
    s[i] = s[j] as number;
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + (s[a] as number)) & 0xff;
    const t = s[a] as number;
    s[a] = s[b] as number;
    s[b] = t;
    out[k] = (data[k] as number) ^ (s[((s[a] as number) + (s[b] as number)) & 0xff] as number);
  }
  return out;
}
