'use strict';

/**
 * Pluggable logger.
 *
 * Line format (stdout / file sinks):
 *   2026-11-02T21:40:05.456Z [INFO ] [webhook:example] POST /webhook/example → 200 (12ms) auth=generic bytes_in=134
 *
 * Sinks are selected by LOG_SINKS (comma separated): stdout | file | logstash.
 * - stdout: plain lines on process.stdout.
 * - file:   append lines to LOG_FILE (directory is created if missing).
 * - logstash: POST NDJSON batches to the Logstash _bulk HTTP endpoint
 *   (LOGSTASH_URL). Events are buffered and flushed on a timer / when the
 *   buffer fills; send failures are reported (throttled) and never crash
 *   the engine.
 *
 * The logstash sink receives structured records
 *   { "@timestamp", "level", "scope", "message", "service" }
 * so the Logstash side can index fields properly.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function formatLine(record) {
  const tag = String(record.level).toUpperCase().padEnd(5);
  return `${record.ts} [${tag}] [${record.scope}] ${record.message}`;
}

class ConsoleSink {
  write(record) {
    process.stdout.write(formatLine(record) + '\n');
  }
  close() {}
}

class FileSink {
  constructor(file) {
    this.file = path.resolve(file);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* best effort; write() will report */
    }
  }
  write(record) {
    try {
      fs.appendFileSync(this.file, formatLine(record) + '\n');
    } catch (e) {
      console.error(`[logger] file sink: failed to write ${this.file}: ${e.message}`);
    }
  }
  close() {}
}

class LogstashSink {
  constructor(url, service) {
    this.url = url;
    this.service = service;
    this.buffer = [];
    this.batchSize = 25;
    this.maxQueue = 1000; // drop oldest beyond this
    this.inflight = false;
    this.droppedWarningAt = 0;
    this.flushTimer = setInterval(() => this.flush(), 1000);
    this.flushTimer.unref();
  }
  write(record) {
    this.buffer.push(record);
    if (this.buffer.length >= this.maxQueue) {
      this.buffer.shift();
      const now = Date.now();
      if (now - this.droppedWarningAt > 15000) {
        this.droppedWarningAt = now;
        console.error('[logger] logstash buffer full — dropping oldest events');
      }
    }
    if (this.buffer.length >= this.batchSize) this.flush();
  }
  flush() {
    if (this.inflight || this.buffer.length === 0) return;
    this.inflight = true;
    const body = this.buffer
      .map((r) => JSON.stringify({ ...r, service: this.service }))
      .join('\n') + '\n';
    this.buffer = [];
    fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Logstash responded with HTTP ${res.status}`);
        if (this.buffer.length > 0) this.flush();
      })
      .catch((e) => {
        const now = Date.now();
        if (now - this.droppedWarningAt > 15000) {
          this.droppedWarningAt = now;
          console.error(`[logger] logstash flush failed (${e.message}) — events stay buffered`);
        }
      })
      .finally(() => {
        this.inflight = false;
        if (this.buffer.length > 0) this.flush();
      });
  }
  close() {
    try {
      this.flush();
    } catch {
      /* ignoring */
    }
    if (this.flushTimer) clearInterval(this.flushTimer);
  }
}

function createLogger({ level = 'info', sinks = ['stdout'], file, logstashUrl, service = 'webhook-engine' } = {}) {
  const impls = [];
  const wanted = Array.isArray(sinks) ? sinks : String(sinks).split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.includes('stdout')) impls.push(new ConsoleSink());
  if (wanted.includes('file')) impls.push(new FileSink(file || './logs/webhook-engine.log'));
  if (wanted.includes('logstash') && logstashUrl) impls.push(new LogstashSink(logstashUrl, service));

  const threshold = LEVELS[level] ?? LEVELS.info;

  function log(level, scope, message) {
    if ((LEVELS[level] ?? 0) < threshold) return;
    const record = { '@timestamp': new Date().toISOString(), ts: new Date().toISOString(), level, scope, message };
    for (const sink of impls) sink.write(record);
  }

  // A logger fixes its scope; its methods take (message) only.
  // Nested children prefix further: parent.child('sub').info('...')
  // The root logger has no scope and renders as "[engine]"; children render
  // their scope as-is, e.g. child('webhook:example').
  function makeLogger(parts) {
    const scope = parts.length ? parts.join(':') : 'engine';
    return {
      scope,
      debug: (message) => log('debug', scope, String(message)),
      info: (message) => log('info', scope, String(message)),
      warn: (message) => log('warn', scope, String(message)),
      error: (message) => log('error', scope, String(message)),
      child: (scope) => makeLogger([...parts, String(scope)]),
      close: closeAll,
    };
  }

  function closeAll() {
    for (const sink of impls) sink.close();
  }

  const root = makeLogger([]);
  root._sinks = impls; // for tests / introspection
  return root;
}

module.exports = { createLogger, LEVELS, formatLine };
