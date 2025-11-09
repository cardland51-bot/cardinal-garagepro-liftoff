const BANNED = ['http://','https://','porn','nsfw'];
export function moderateText(text='') {
  const t = (text||'').toLowerCase();
  if (t.length > 500) return { ok:false, flags:['TEXT_TOO_LONG'] };
  if (BANNED.some(k=> t.includes(k))) return { ok:false, flags:['BANNED_TERM'] };
  const digits = (t.match(/[0-9]/g)||[]).length;
  if (digits >= 12) return { ok:false, flags:['POSSIBLE_PII'] };
  return { ok:true, flags:[] };
}
export function validateGeo(state, city) {
  const US = /^[A-Z]{2}$/;
  if (!US.test(state||'')) return false;
  if (city && city.length > 64) return false;
  return true;
}
