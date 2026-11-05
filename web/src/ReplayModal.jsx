import React, { useEffect } from 'react';
import { TreeSection } from './JsonTree.jsx';
import BodyView, { tryParseJson } from './BodyView.jsx';

/**
 * Modal overlay shown after a replay: the webhook's ANSWER (captured
 * transiently by POST /api/calls/:id/replay — bodies are never persisted to
 * the call log) with JSON trees + raw toggle, the response headers, and the
 * freshly recorded replay ROW (the request the replay re-sent, incl. its
 * X-Replay provenance tag).
 *
 * `result` is the replay API payload:
 *   { original, status, responseBytes, response: { status, headers, body, truncated }, call }
 */

function hasKeys(o) {
  return o && typeof o === 'object' && Object.keys(o).length > 0;
}

export default function ReplayModal({ result, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { original, response, call } = result;
  const resp = response || {};
  const respRaw = typeof resp.body === 'string' ? resp.body : '';
  const respParsed = tryParseJson(respRaw);
  const status = result.status ?? call?.status ?? 0;
  const statusCls = `status s${String(status).startsWith('2') ? '2' : String(status).startsWith('4') ? '4' : '5'}`;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <span className="modal-title">
            replay <code>#{original?.id}</code>
            {call ? (
              <> → new call <code>#{call.id}</code></>
            ) : (
              <em className="section-hint"> — answered, but no new call row appeared yet</em>
            )}
          </span>
          <button className="modal-close" onClick={onClose} title="close (Esc)">✕</button>
        </div>

        <div className="meta-grid">
          <span>webhook <b>{original?.webhook}</b></span>
          <span>method <b>{original?.method}</b></span>
          <span>path <b>{original?.path}</b></span>
          <span>answered <b className={statusCls}>{status}</b></span>
          {call && <span>auth <b>{call.auth}</b></span>}
          {call && <span>ms <b>{call.durationMs ?? '—'}</b></span>}
          <span>response <b>{result.responseBytes ?? respRaw.length} bytes</b>{resp.truncated ? <em className="section-hint"> (first {respRaw.length} captured)</em> : null}</span>
        </div>

        <BodyView
          title="replay response"
          raw={respRaw}
          parsed={respParsed}
          hint="transient — the webhook's answer, not stored in the call log"
        />

        {hasKeys(resp.headers) && <TreeSection title={`response headers (${Object.keys(resp.headers).length})`} value={resp.headers} />}

        {call && (
          <>
            <TreeSection title={`replayed request headers (${call.headers ? Object.keys(call.headers).length : 0})`} value={call.headers || {}} hint="re-sent request — note x-replay; auth values redacted at rest" />
            {hasKeys(call.query) && <TreeSection title={`query params (${Object.keys(call.query).length})`} value={call.query} />}
            <BodyView
              title="replayed request body"
              raw={call.body && typeof call.body.raw === 'string' ? call.body.raw : ''}
              parsed={call.body && call.body.json != null ? call.body.json : null}
            />
          </>
        )}
      </div>
    </div>
  );
}
