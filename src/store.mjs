export class StoreError extends Error {}

export class Store {
  constructor(url, secretKey, fetchFn = fetch) {
    const cleanUrl = (url || '').replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cleanUrl) || !secretKey?.startsWith('sb_secret_')) {
      throw new StoreError('Неверные SUPABASE_URL или SUPABASE_SECRET_KEY в Secrets');
    }
    this.url = cleanUrl;
    this.secretKey = secretKey;
    this.fetchFn = fetchFn;
  }

  async request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await this.fetchFn(this.url + '/rest/v1/' + path, {
        method,
        headers: {
          apikey: this.secretKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(method === 'PATCH' ? { Prefer: 'return=minimal' } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new StoreError('Supabase: ошибка сети или timeout');
    }
    if (!response.ok) throw new StoreError(`Supabase: HTTP ${response.status}. Проверьте SQL, URL и Secret Key`);
    if (response.status === 204 || method === 'PATCH') return null;
    try { return await response.json(); }
    catch { throw new StoreError('Supabase: неверный JSON'); }
  }

  rpc(name, body) { return this.request(`rpc/${name}`, { method: 'POST', body }); }
  begin(force) { return this.rpc('begin_check', { p_force: force }); }
  complete(lease, masterId, slots, error, durationMs) {
    return this.rpc('complete_check', {
      p_lease: lease, p_master_id: masterId, p_slots: slots, p_error: error,
      p_duration_ms: Math.max(0, Math.round(durationMs))
    });
  }
  pending() {
    return this.request('notification_outbox?select=id,master_id,kind,checked_at,slots,slot_count,next_due_at,error&sent_at=is.null&order=id.asc&limit=20');
  }
  markDelivery(id, error) { return this.rpc('mark_delivery', { p_id: id, p_error: error }); }
  recordTest(error) {
    return this.request('app_settings?id=eq.1', {
      method: 'PATCH', body: error
        ? { last_telegram_error: error }
        : { last_telegram_at: new Date().toISOString(), last_telegram_error: null }
    });
  }
}
