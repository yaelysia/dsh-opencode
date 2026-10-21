/** Preserve provider failures without logging credentials or entire response bodies. */
export function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '$1 [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:key|token|api_key|access_token)=)[^\s&#]+/gi, '$1[redacted]')
    .slice(0, 1200);
}

export function failure(message, code, status) {
  const error = new Error(redact(message));
  error.code = code;
  error.failure = Object.freeze({ message: error.message, code,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
  });
  return error;
}

export function providerFailure(value, httpStatus) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = { message: value }; }
  }
  const source = value?.info?.error ?? value?.error ?? value;
  const data = source?.data ?? source;
  const status = Number(data?.statusCode ?? data?.status ?? httpStatus);
  const kind = source?.name ?? source?.type ?? 'APIError';
  const message = data?.message ?? source?.message ?? data?.responseBody
    ?? (typeof source === 'string' ? source : 'request failed');
  const text = String(message);
  let code = status === 401 ? 'AUTH' : status === 403 ? 'FORBIDDEN'
    : status === 429 ? 'RATE_LIMIT' : 'MODEL_ERROR';
  if (/detected abusive traffic|free models aren't available from your current network/i.test(text)) code = 'NETWORK_BLOCKED';
  else if (/only be used (?:from within|in) opencode/i.test(text)) code = 'CLIENT_RESTRICTED';
  else if (kind === 'RegionError' || /not available in your country/i.test(text)) code = 'REGION_RESTRICTED';
  else if (kind === 'UpgradeRequired' || status === 426) code = 'UPGRADE_REQUIRED';
  return failure('OpenCode ' + kind + ': ' + text, code, status);
}
