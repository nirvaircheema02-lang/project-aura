import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_REQUEST_MODEL } from '@opentelemetry/semantic-conventions/incubating';
import type Database from 'better-sqlite3';

/** Structural stand-in for @opentelemetry/core's ExportResult — that package is a transitive dep, not a direct one. */
type ExportResult = { code: number; error?: Error };

/**
 * §2.6 Execution Tracing. Real OpenTelemetry spans (so any standard backend
 * can consume them) exported into the T-layer's own `spans` table, which is
 * kept deliberately separate from S7: S7 is audit-domain history (what the
 * site looks like), this is graph-execution history (what the agent did).
 * This is what gives `reason: NODE_FAILURE` an actual diagnostic trail.
 *
 * GenAI attribute names come from the semantic-conventions package rather
 * than hardcoded strings, so they track the spec instead of drifting.
 */

export const TRACER_NAME = 'ken-audit-agent';

/** Writes finished spans into the run database. Synchronous by design — better-sqlite3 is. */
export class SqliteSpanExporter implements SpanExporter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * The OTel global tracer provider can only be set once per process, but the
   * database it writes to is per-run (and, in tests, per-case). Rebinding the
   * exporter's target is how one provider serves many databases — the
   * alternative, a provider captured around the first db, silently writes
   * every later run's spans into a closed handle.
   */
  setDb(db: Database.Database): void {
    this.db = db;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO spans (span_id, run_id, page_id, node_id, attempt_number, status, started_at, ended_at, error_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const span of spans) {
        const attrs = span.attributes as Record<string, string | number | undefined>;
        insert.run(
          span.spanContext().spanId,
          String(attrs['audit.run_id'] ?? ''),
          attrs['audit.page_id'] === undefined ? null : String(attrs['audit.page_id']),
          String(attrs['audit.node_id'] ?? span.name),
          Number(attrs['audit.attempt'] ?? 1),
          span.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
          Math.round(span.startTime[0] * 1000 + span.startTime[1] / 1e6),
          Math.round(span.endTime[0] * 1000 + span.endTime[1] / 1e6),
          span.status.message ?? null,
        );
      }
      resultCallback({ code: 0 });
    } catch (err) {
      resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  async shutdown(): Promise<void> {}
}

let provider: BasicTracerProvider | undefined;
let exporter: SqliteSpanExporter | undefined;

/** Installs the SQLite-backed tracer, or re-points an existing one at `db`. Safe to call repeatedly. */
export function initTracing(db: Database.Database): Tracer {
  if (!provider || !exporter) {
    exporter = new SqliteSpanExporter(db);
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  } else {
    exporter.setDb(db);
  }
  return trace.getTracer(TRACER_NAME);
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export interface SpanContextInput {
  runId: string;
  nodeId: string;
  attempt: number;
  pageId?: string | undefined;
  /** Set for AI nodes so the GenAI conventions apply to exactly the spans that are model calls. */
  model?: string | undefined;
  isAi?: boolean;
}

/** Wraps one node attempt in a span. Errors are recorded on the span AND rethrown — tracing never swallows a failure. */
export async function withNodeSpan<T>(input: SpanContextInput, fn: () => Promise<T>): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(input.nodeId, async (span: Span) => {
    span.setAttribute('audit.run_id', input.runId);
    span.setAttribute('audit.node_id', input.nodeId);
    span.setAttribute('audit.attempt', input.attempt);
    if (input.pageId) span.setAttribute('audit.page_id', input.pageId);
    if (input.isAi) {
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, 'chat');
      if (input.model) span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, input.model);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const message = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface SpanRow {
  span_id: string;
  run_id: string;
  page_id: string | null;
  node_id: string;
  attempt_number: number;
  status: string;
  started_at: number;
  ended_at: number | null;
  error_detail: string | null;
}

export function spansForRun(db: Database.Database, runId: string): SpanRow[] {
  // rowid breaks the tie: node attempts can start within the same millisecond,
  // and a retry trail is only readable if attempt 2 stays after attempt 1.
  return db.prepare('SELECT * FROM spans WHERE run_id = ? ORDER BY started_at, rowid').all(runId) as SpanRow[];
}
