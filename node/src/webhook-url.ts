// A API só aceita webhook em HTTPS num host público: nada de `http`, `localhost`, IP privado ou
// de loopback (é a defesa dela contra SSRF). Conferir aqui, antes de chamar, poupa uma ida à API
// que devolveria `422 webhook-url-invalid`. A regra da API é a que vale; esta é um espelho.

export function motivoUrlWebhookInvalida(texto: string): string | null {
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return 'não é uma URL';
  }
  if (url.protocol !== 'https:') return 'precisa ser https';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return 'localhost não é alcançável pela API';
  if (host === '::1' || host === '0.0.0.0') return 'endereço de loopback';
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return 'IP privado ou de loopback';
    if (a === 192 && b === 168) return 'IP privado';
    if (a === 172 && b >= 16 && b <= 31) return 'IP privado';
    if (a === 169 && b === 254) return 'endereço de link-local ou de metadados';
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return 'IPv6 privado ou de link-local';
  return null;
}
