import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Modal to manage the engine's db-managed bearer tokens (GET/POST/
 * POST-revoke under /api/tokens). Master-token principals only — App.jsx
 * shows the entry button only when /api/whoami says { source: 'master' },
 * and the server enforces 403 independently.
 *
 * A token's plaintext exists only in the POST response; after that the table
 * shows just its display prefix and only replacement is possible.
 */

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function TokensModal({ token, onClose }) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null); // one-time reveal: { plaintext, meta }
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState(null); // token id armed for revoke

  const load = useCallback(async () => {
    try {
      const data = await api('/api/tokens', { token });
      setTokens(data.tokens || []);
      setError(null);
    } catch (e) {
      setError(e.status === 403 ? 'not the master token — token management is only allowed with the env master bearer token' : e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const data = await api('/api/tokens', {
        token,
        method: 'POST',
        body: { name: name.trim(), expiresAt: expiresAt || null },
      });
      setCreated({ plaintext: data.plaintext, meta: data.token });
      setName('');
      setExpiresAt('');
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }, [token, name, expiresAt, load]);

  const revoke = useCallback(
    async (id) => {
      if (confirmId !== id) {
        setConfirmId(id); // two-step: second click within the row actually revokes
        return;
      }
      setConfirmId(null);
      setError(null);
      try {
        await api(`/api/tokens/${id}/revoke`, { token, method: 'POST' });
        load();
      } catch (e) {
        setError(e.message);
      }
    },
    [token, confirmId, load]
  );

  const copy = useCallback(() => {
    if (!created) return;
    navigator.clipboard
      .writeText(created.plaintext)
      .then(() => setCopied(true))
      .catch(() => setError('clipboard unavailable — select the token text and copy manually'));
  }, [created]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <span className="modal-title">API bearer tokens</span>
          <button className="modal-close" onClick={onClose} title="close (Esc)">✕</button>
        </div>

        <div className="meta-grid">
          <span>the <b>env master token</b> authenticates everything and is the only credential that can manage these</span>
          <span>db tokens work on <b>useGlobalAuth webhooks</b> and <b>/api/*</b> (except token management)</span>
          <span>a plaintext token is shown <b>once</b> — at creation only</span>
        </div>

        {created && (
          <div className="tok-reveal">
            <div className="tok-reveal-title">
              new token <b>{created.meta.name}</b> — copy it now, it can never be shown again
            </div>
            <code className="tok-plaintext">{created.plaintext}</code>
            <div className="section-tools">
              <button className="mini-btn" onClick={copy}>{copied ? 'copied ✓' : 'copy'}</button>
              <button className="mini-btn" onClick={() => { setCreated(null); setCopied(false); }}>done</button>
            </div>
          </div>
        )}

        {error && <div className="error-banner">tokens: {error}</div>}

        <div className="tok-form">
          <input
            type="text"
            placeholder="token name (e.g. ci-deploy)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create(); }}
          />
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            title="expiry date (optional; ends that UTC day)"
          />
          <button onClick={create} disabled={creating || !name.trim()}>
            {creating ? 'creating…' : '+ create token'}
          </button>
        </div>

        <table className="tok-table">
          <thead>
            <tr>
              <th>name</th>
              <th>token</th>
              <th>created</th>
              <th>expires</th>
              <th>last used</th>
              <th>status</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="empty">loading…</td></tr>
            )}
            {!loading && tokens.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  no db tokens yet — create one above, or keep using the env master token.
                </td>
              </tr>
            )}
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><code>{t.prefix}…</code></td>
                <td title={t.createdAt}>{fmtDate(t.createdAt)}</td>
                <td>{t.expiresAt ? fmtDate(t.expiresAt) : 'never'}</td>
                <td>{t.lastUsedAt ? fmtDate(t.lastUsedAt) : '—'}</td>
                <td><span className={`tok-badge ${t.status}`}>{t.status}</span></td>
                <td>
                  {t.status !== 'revoked' && (
                    <button
                      className={confirmId === t.id ? 'revoke-confirm' : 'secondary'}
                      onClick={() => revoke(t.id)}
                      title={`revoke "${t.name}" (soft: the row stays as an audit trail)`}
                    >
                      {confirmId === t.id ? 'sure?' : 'revoke'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
