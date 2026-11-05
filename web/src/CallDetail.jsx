import React, { useEffect, useState } from 'react';
import JsonTree from './JsonTree.jsx';

/**
 * Modal overlay showing one recorded call in full: meta line plus
 * expandable trees for headers, query params and the body. The body shows
 * a parsed-JSON tree when the payload is JSON (Tree ⇄ Raw toggle) and raw
 * text otherwise. All data comes from the row the list API already loaded.
 */

function tryParseJson(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function hasKeys(o) {
  return o && typeof o === 'object' && Object.keys(o).length > 0;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http/non-localhost contexts: fall back to a hidden textarea
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function TreeSection({ title, value, hint }) {
  // forceOpen is applied via re-mount: bumping seq re-creates the tree.
  const [ctrl, setCtrl] = useState({ open: undefined, seq: 0 });
  const apply = (open) => setCtrl((c) => ({ open, seq: c.seq + 1 }));
  return (
    <div className="detail-section">
      <div className="section-head">
        <h3>{title}</h3>
        <span className="section-tools">
          {hint && <em className="section-hint">{hint}</em>}
          <button className="mini-btn" onClick={() => apply(true)} title="expand all nodes">expand all</button>
          <button className="mini-btn" onClick={() => apply(false)} title="collapse all nodes">collapse</button>
        </span>
      </div>
      <JsonTree key={`${title}:${ctrl.seq}`} value={value} forceOpen={ctrl.open} />
    </div>
  );
}

export default function CallDetail({ row, onClose }) {
  const [bodyMode, setBodyMode] = useState('tree'); // 'tree' | 'raw'
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const body = row.body || {};
  const raw = typeof body.raw === 'string' ? body.raw : '';
  const parsed = body.json !== null && body.json !== undefined ? body.json : tryParseJson(raw);
  const formViews = { ...(hasKeys(body.url) ? body.url : {}), ...(hasKeys(body.post) ? body.post : {}) };
  const statusCls = `status s${String(row.status).startsWith('2') ? '2' : String(row.status).startsWith('4') ? '4' : '5'}`;

  const doCopy = async (label, text) => {
    const ok = await copyText(text);
    setCopied(ok ? `${label} copied` : 'copy failed');
    setTimeout(() => setCopied(''), 1500);
  };

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
            call <code>#{row.id}</code>
          </span>
          <button className="modal-close" onClick={onClose} title="close (Esc)">✕</button>
        </div>

        <div className="meta-grid">
          <span>webhook <b>{row.webhook}</b></span>
          <span>method <b>{row.method}</b></span>
          <span>path <b>{row.path}</b></span>
          <span>status <b className={statusCls}>{row.status}</b></span>
          <span>auth <b>{row.auth}</b></span>
          <span>ms <b>{row.durationMs ?? '—'}</b></span>
          <span>at <b title={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</b></span>
          {row.replayedFromId != null && <span>replay of <b>#{row.replayedFromId}</b></span>}
        </div>

        <TreeSection title={`headers (${row.headers ? Object.keys(row.headers).length : 0})`} value={row.headers || {}} hint="auth values are redacted at rest" />

        {hasKeys(row.query) && <TreeSection title={`query params (${Object.keys(row.query).length})`} value={row.query} />}

        <div className="detail-section">
          <div className="section-head">
            <h3>body {raw ? `(${raw.length} bytes)` : '(empty)'}</h3>
            <span className="section-tools">
              {copied && <em className="section-hint">{copied}</em>}
              {parsed !== null && (
                <span className="view-toggle">
                  <button className={`mini-btn${bodyMode === 'tree' ? ' active' : ''}`} onClick={() => setBodyMode('tree')}>tree</button>
                  <button className={`mini-btn${bodyMode === 'raw' ? ' active' : ''}`} onClick={() => setBodyMode('raw')}>raw</button>
                </span>
              )}
              {raw !== '' && (
                <button className="mini-btn" onClick={() => doCopy('body', raw)} title="copy raw body to clipboard">⧉ copy</button>
              )}
            </span>
          </div>
          {raw === '' && parsed === null ? (
            <p className="section-empty">no body recorded</p>
          ) : parsed !== null && bodyMode === 'tree' ? (
            <JsonTree value={parsed} />
          ) : (
            <pre className="raw-body">{raw}</pre>
          )}
        </div>

        {hasKeys(formViews) && <TreeSection title={`form fields (${Object.keys(formViews).length})`} value={formViews} />}
      </div>
    </div>
  );
}
