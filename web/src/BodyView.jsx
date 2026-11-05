import React, { useState } from 'react';
import JsonTree from './JsonTree.jsx';

/**
 * Shared "body" section for the detail modals: parsed-JSON tree with a
 * tree ⇄ raw toggle when the payload is JSON, raw <pre> otherwise, plus a
 * copy button. Used for recorded call bodies AND for transient replay
 * responses (the webhook's answer).
 */

export function tryParseJson(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
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

export default function BodyView({ title = 'body', raw, parsed, hint }) {
  const [mode, setMode] = useState('tree'); // 'tree' | 'raw'
  const [copied, setCopied] = useState('');

  const doCopy = async () => {
    const ok = await copyText(raw);
    setCopied(ok ? 'copied' : 'copy failed');
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div className="detail-section">
      <div className="section-head">
        <h3>
          {title} {raw ? `(${raw.length} bytes)` : '(empty)'}
        </h3>
        <span className="section-tools">
          {hint && <em className="section-hint">{hint}</em>}
          {copied && <em className="section-hint">{copied}</em>}
          {parsed !== null && (
            <span className="view-toggle">
              <button className={`mini-btn${mode === 'tree' ? ' active' : ''}`} onClick={() => setMode('tree')}>tree</button>
              <button className={`mini-btn${mode === 'raw' ? ' active' : ''}`} onClick={() => setMode('raw')}>raw</button>
            </span>
          )}
          {raw !== '' && (
            <button className="mini-btn" onClick={doCopy} title="copy to clipboard">⧉ copy</button>
          )}
        </span>
      </div>
      {raw === '' && parsed === null ? (
        <p className="section-empty">no body recorded</p>
      ) : parsed !== null && mode === 'tree' ? (
        <JsonTree value={parsed} />
      ) : (
        <pre className="raw-body">{raw}</pre>
      )}
    </div>
  );
}
