import React, { useState } from 'react';

/**
 * Dependency-free collapsible tree for JSON-shaped values
 * (objects, arrays, primitives) — used for headers, query and body.
 *
 *   <JsonTree value={data} forceOpen={undefined | true | false} />
 *
 * forceOpen: undefined → open by depth (depth < AUTO_EXPAND_DEPTH);
 * true/false → fully open/closed. Node state lives in useState, so callers
 * that want expand-all/collapse-all to re-apply must re-mount the tree
 * (bump the key).
 */

const AUTO_EXPAND_DEPTH = 2; // nodes shallower than this start expanded
const MAX_INLINE_STR = 160; // longer strings truncate until clicked

function isContainer(v) {
  return v !== null && typeof v === 'object';
}

function summarize(v) {
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  const n = Object.keys(v).length;
  return `{${n} key${n === 1 ? '' : 's'}}`;
}

function Leaf({ name, asIndex, value }) {
  const type = value === null ? 'null' : typeof value;
  if (type === 'string' && value.length > MAX_INLINE_STR) {
    return <LongString name={name} asIndex={asIndex} value={value} />;
  }
  const text = type === 'string' ? `"${value}"` : String(value);
  return (
    <div className="jt-node">
      <span className="jt-toggle" />
      {name !== undefined && <Key name={name} asIndex={asIndex} />}
      <span className={`jt-val t-${type}`}>{text}</span>
    </div>
  );
}

function Key({ name, asIndex }) {
  return (
    <>
      <span className={asIndex ? 'jt-idx' : 'jt-key'}>{name}</span>
      <span className="jt-punct">: </span>
    </>
  );
}

function LongString({ name, asIndex, value }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? value : `${value.slice(0, MAX_INLINE_STR)}…`;
  return (
    <div className="jt-node">
      <span className="jt-toggle">·</span>
      {name !== undefined && <Key name={name} asIndex={asIndex} />}
      <span
        className={`jt-val t-string jt-longstr${expanded ? ' expanded' : ''}`}
        title={`${value.length} chars — click to ${expanded ? 'collapse' : 'expand'}`}
        onClick={() => setExpanded((e) => !e)}
      >
        "{shown}"
      </span>
    </div>
  );
}

function Node({ name, asIndex, value, depth, forceOpen }) {
  const [open, setOpen] = useState(forceOpen === undefined ? depth < AUTO_EXPAND_DEPTH : forceOpen);

  if (!isContainer(value)) return <Leaf name={name} asIndex={asIndex} value={value} />;

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v, true]) : Object.entries(value).map(([k, v]) => [k, v, false]);

  if (entries.length === 0) {
    return (
      <div className="jt-node">
        <span className="jt-toggle" />
        {name !== undefined && <Key name={name} asIndex={asIndex} />}
        <span className="jt-punct">{isArr ? '[]' : '{}'}</span>
      </div>
    );
  }

  return (
    <div className="jt-node">
      <span className={`jt-toggle ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)} title={open ? 'collapse' : 'expand'}>
        {open ? '▾' : '▸'}
      </span>
      {name !== undefined && <Key name={name} asIndex={asIndex} />}
      <span className="jt-punct">{open ? (isArr ? '[' : '{') : summarize(value)}</span>
      {open && (
        <div className="jt-children">
          {entries.map(([k, v, idx]) => (
            <Node key={k} name={k} asIndex={idx} value={v} depth={depth + 1} forceOpen={forceOpen} />
          ))}
        </div>
      )}
      {open && <span className="jt-punct jt-close">{isArr ? ']' : '}'}</span>}
    </div>
  );
}

export default function JsonTree({ value, forceOpen }) {
  return (
    <div className="json-tree">
      <Node name={undefined} value={value} depth={0} forceOpen={forceOpen} />
    </div>
  );
}

/** Detail-view section: titled JsonTree with expand-all / collapse controls.
 *  forceOpen is applied via re-mount: bumping seq re-creates the tree. */
export function TreeSection({ title, value, hint }) {
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
