export const NODE_TYPES = ['indicator', 'malware', 'campaign', 'technique', 'report', 'actor'];
export const CONFIDENCE = { low: 1, medium: 2, high: 3 };

const any = NODE_TYPES;
const notReport = NODE_TYPES.filter((t) => t !== 'report');

export const RELATIONS = {
  uses: { from: ['campaign', 'malware'], to: ['malware', 'technique'] },
  indicates: { from: ['indicator'], to: ['malware', 'campaign'] },
  'reported-in': { from: notReport, to: ['report'] },
  'attributed-to': { from: ['indicator', 'malware', 'campaign', 'report'], to: ['actor'] },
  'related-to': { from: any, to: any },
};

export function isWeak(edge) {
  return edge.confidence === 'low' || edge.rel === 'related-to';
}

const HASH_LEN = { 32: 'md5', 40: 'sha1', 64: 'sha256' };

export function refang(value) {
  return String(value)
    .trim()
    .replace(/^hxxp/i, 'http')
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\[:\]/g, ':')
    .replace(/\[@\]|\[at\]/gi, '@');
}

export function indicatorKind(value) {
  const v = refang(value);
  if (/^[a-f0-9]+$/i.test(v) && HASH_LEN[v.length]) return HASH_LEN[v.length];
  if (/^https?:\/\//i.test(v)) return 'url';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return 'ip';
  if (/^[^@\s]+@[^@\s]+$/.test(v)) return 'email';
  if (/^([a-z0-9-]+\.)+[a-z]{2,}\.?$/i.test(v)) return 'domain';
  return 'other';
}

export function canonicalIndicator(value) {
  const v = refang(value);
  switch (indicatorKind(v)) {
    case 'md5':
    case 'sha1':
    case 'sha256':
    case 'email':
      return v.toLowerCase();
    case 'domain':
      return v.toLowerCase().replace(/\.$/, '');
    case 'ip':
      return v.split('.').map((o) => String(Number(o))).join('.');
    case 'url': {
      try {
        const u = new URL(v);
        u.hash = '';
        return u.href.replace(/\/$/, '');
      } catch {
        return v;
      }
    }
    default:
      return v;
  }
}
