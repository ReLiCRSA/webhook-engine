import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const PAGE = 100;
const REFRESH_MS = 5000;

const STATUS_COLORS = {
  '401': 'var(--bad)', '404': 'var(--bad)', '500': 'var(--bad)',
  '200': 'var(--ok)', '201': 'var(--ok)', '204': 'var(--ok)',
};

function timeAgo(iso) {
  try {
    const d = new Date(iso);
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function App() {
  const [token, setTokenState] = useState(getToken);
  const [prompting, setPrompting] = useState(false);
  const [webhooks, setWebhooks] = useState([]);
  const [filterWebhook, setFilterWebhook] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [since, setSince] = useState('');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(true);
  const [auto, setAuto] = useState(true);

  const askForToken = useCallback(() => {
    setPrompting(true);
  }, []);

  const submitToken = useCallback((value) => {
    setToken(value);
    setTokenState(value);
    setPrompting(false);
    setOffset(0);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (filterWebhook) qs.set('webhook', filterWebhook);
      if (filterMethod) qs.set('method', filterMethod);
      if (filterStatus) qs.set('status', filterStatus);
      if (since) qs.set('since', since);
      qs.set('limit', String(PAGE));
      qs.set('offset', String(offset));
      const data = await api(`/api/calls?${qs.toString()}`, { token });
      setRows(data.rows);
      setTotal(data.total);
      setRefreshing(false);
    } catch (e) {
      if (e.status === 401) {
        askForToken();
      } else {
        setError(e.message);
        setRefreshing(false);
      }
    }
  }, [token, filterWebhook, filterMethod, filterStatus, since, offset, askForToken]);

  // Load the webhook list once.
  useEffect(() => {
    api('/api/webhooks', { token })
      .then((d) => setWebhooks(d.webhooks || []))
      .catch(() => { /* handled via /calls 401 */ });
  }, [token]);

  // Initial load + auto-refresh.
  useEffect(() => {
    setRefreshing(true);
    load();
    if (!auto) return;
    const t = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load, auto, filterWebhook, filterMethod, filterStatus, since]);

  const resetPaging = () => setOffset(0);

  if (prompting) {
    return (
      <div className="token-prompt">
        <div>
          <h1>Authentication required</h1>
          <p>Provide the bearer token for this engine (AUTH_BEARER_TOKEN).</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = e.target.elements.token.value.trim();
              submitToken(v);
            }}
          >
            <input name="token" type="password" autoFocus placeholder="Bearer token" />
            <button type="submit">Save &amp; continue</button>
            <button type="button" className="secondary" onClick={() => setPrompting(false)}>Cancel</button>
          </form>
          <p className="hint">The token is stored in your browser (localStorage) only.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>Webhook Engine</h1>
        <div className="header-right">
          <label>
            token <code>{token ? `${token.slice(0, 4)}…` : 'none'}</code>
            <button className="link" onClick={() => askForToken()}>change</button>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto-refresh ({REFRESH_MS / 1000}s)
          </label>
          <button onClick={() => { setRefreshing(true); load(); }} disabled={refreshing}>
            {refreshing ? 'loading…' : 'refresh'}
          </button>
        </div>
      </header>

      <div className="toolbar">
        <select value={filterWebhook} onChange={(e) => { setFilterWebhook(e.target.value); resetPaging(); }}>
          <option value="">all webhooks</option>
          {webhooks.map((w) => (
            <option key={w.name} value={w.name}>
              {w.name} ({w.auth})
            </option>
          ))}
        </select>
        <select value={filterMethod} onChange={(e) => { setFilterMethod(e.target.value); resetPaging(); }}>
          <option value="">any method</option>
          {['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); resetPaging(); }}>
          <option value="">any status</option>
          {['200', '201', '401', '404', '500'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input type="date" value={since} onChange={(e) => { setSince(e.target.value); resetPaging(); }} title="since (date)" />
        <span>{since ? `&nbsp;since ${since}` : ''}</span>
      </div>

      {error && <div className="error-banner">API error: {error} (is the engine running? token valid?)</div>}

      <div className="summary">
        total matching: <strong>{total}</strong> · showing <strong>{rows.length}</strong> from offset {offset}
      </div>

      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>webhook</th>
            <th>method</th>
            <th>path</th>
            <th>status</th>
            <th>auth</th>
            <th>ms</th>
            <th>in</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !refreshing && (
            <tr>
              <td colSpan={8} className="empty">
                {total === 0 ? (
                  <>
                    No calls recorded yet — send a request to a webhook, e.g.{' '}
                    <code>{'curl -X POST /webhook/example -H "Authorization: Bearer <token>" -d \'{"hello":"world"}\''}</code>
                  </>
                ) : (
                  'No calls match the current filters.'
                )}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="time" title={r.createdAt}>{timeAgo(r.createdAt)}</td>
              <td>{r.webhook}</td>
              <td>{r.method}</td>
              <td className="path" title={r.path}>{r.path}</td>
              <td className={STATUS_COLORS[r.status] ? '' : 'other'}>
                <span className={`status s${String(r.status).startsWith('2') ? '2' : String(r.status).startsWith('4') ? '4' : '5'}`}>{r.status}</span>
              </td>
              <td>{r.auth}</td>
              <td>{r.durationMs ?? '—'}</td>
              <td>{r.body ? String(r.body.raw || '').length : 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {offset + rows.length < total && (
        <div className="pager">
          <button onClick={() => setOffset((o) => o + PAGE)}>load more ({Math.max(0, total - offset - rows.length)} left)</button>
        </div>
      )}

      <footer>
        <span>webhooks discovered: </span>
        {webhooks.length === 0 && <em>none</em>}
        {webhooks.map((w) => (
          <code key={w.name} title={`auth: ${w.auth}`}>{w.name}</code>
        ))}
      </footer>
    </div>
  );
}
