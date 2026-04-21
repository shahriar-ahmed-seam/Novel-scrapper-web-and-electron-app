export function isLikelyOfflineError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = String(err?.code || err?.cause?.code || '').toUpperCase();

  if (code === 'ENOTFOUND') return true;
  if (code === 'EAI_AGAIN') return true;
  if (code === 'ECONNRESET') return true;
  if (code === 'ECONNREFUSED') return true;
  if (code === 'ETIMEDOUT') return true;
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if (code === 'UND_ERR_SOCKET') return true;

  if (msg.includes('fetch failed')) return true;
  if (msg.includes('network')) return true;
  if (msg.includes('socket')) return true;
  if (msg.includes('timed out')) return true;
  if (msg.includes('getaddrinfo')) return true;

  return false;
}
