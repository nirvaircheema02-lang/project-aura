import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_REQUEST_MODEL } from '@opentelemetry/semantic-conventions/incubating';

/** Structural stand-in for @opentelemetry/core's ExportResult — that package is a transitive dep, not a direct one. */
type ExportResult = { code: number; error?: Error };

/**
 * Execution tracing — vendored from audit-agent `src/tracing/index.ts` (its §2.6) with ONE
 * adaptation (Decision Log #4): spans are exported to a JSON-lines file inside the redesign
 * run's own output folder (`trace.jsonl`) instead of a SQLite `spans` table. This repo keeps
 * no database; the trail lands next to the artifacts it explains. Real OpenTelemetry spans
 * still, so any standard backend can consume them later.
 *
 * Every pipeline step is one span keyed `(redesignRunId, nodeId, attempt)`, where `attempt`
 * is the R3→R4→R5 loop iteration — so a failure is attributable to a specific node AND a
 * specific iteration, never a monolithic retry (ARCHITECTURE.md Q8).
 */

export const TRACER_NAME = 'ken-fix-redesign-agent';

export interface SpanRecord {
  spanId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: 'OK' | 'ERROR';
  startedAt: number;
  endedAt: number;
  errorDetail: string | null;
  model: string | null;
}

export function toSpanRecord(span: ReadableSpan): SpanRecord {
  const attrs = span.attributes as Record<string, string | number | undefined>;
  return {
    spanId: span.spanContext().spanId,
    runId: String(attrs['redesign.run_id'] ?? ''),
    nodeId: String(attrs['redesign.node_id'] ?? span.name),
    attempt: Number(attrs['redesign.attempt'] ?? 1),
    status: span.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
    startedAt: Math.round(span.startTime[0] * 1000 + span.startTime[1] / 1e6),
    endedAt: Math.round(span.endTime[0] * 1000 + span.endTime[1] / 1e6),
    errorDetail: span.status.message ?? null,
    model: attrs[ATTR_GEN_AI_REQUEST_MODEL] === undefined ? null : String(attrs[ATTR_GEN_AI_REQUEST_MODEL]),
  };
}

/** Appends finished spans to a `.jsonl` file, one JSON object per line. Synchronous by design — small, append-only. */
export class JsonlSpanExporter implements SpanExporter {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  setPath(path: string): void {
    this.path = path;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, spans.map((s) => `${JSON.stringify(toSpanRecord(s))}\n`).join(''));
      resultCallback({ code: 0 });
    } catch (err) {
      resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  async shutdown(): Promise<void> {}
}

/** Keeps spans in memory — for tests, and for a `--dry-run` that writes nothing to disk. */
export class MemorySpanExporter implements SpanExporter {
  readonly records: SpanRecord[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const s of spans) this.records.push(toSpanRecord(s));
    resultCallback({ code: 0 });
  }

  async shutdown(): Promise<void> {}
}

/**
 * The OTel global tracer provider can only be set once per process, but the sink is per-run
 * (and, in tests, per-case). Delegating to a swappable target is how one provider serves
 * many runs — the same trick audit-agent's exporter plays with `setDb`.
 */
class DelegatingExporter implements SpanExporter {
  target: SpanExporter;

  constructor(target: SpanExporter) {
    this.target = target;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.target.export(spans, resultCallback);
  }

  async shutdown(): Promise<void> {
    await this.target.shutdown();
  }
}

let provider: BasicTracerProvider | undefined;
let delegate: DelegatingExporter | undefined;

/** Installs the tracer (or re-points the existing one) at `sink` — a `.jsonl` path or any SpanExporter. Safe to call repeatedly. */
export function initTracing(sink: string | SpanExporter): Tracer {
  const exporter = typeof sink === 'string' ? new JsonlSpanExporter(sink) : sink;
  if (!provider || !delegate) {
    delegate = new DelegatingExporter(exporter);
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(delegate)] });
    trace.setGlobalTracerProvider(provider);
  } else {
    delegate.target = exporter;
  }
  return trace.getTracer(TRACER_NAME);
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export interface SpanContextInput {
  runId: string;
  nodeId: string;
  /** The R3→R4→R5 loop iteration for looped nodes; 1 for R1/R2/R7. */
  attempt: number;
  /** Set for model-calling nodes so the GenAI conventions apply to exactly the spans that are model calls. */
  model?: string | undefined;
  isAi?: boolean;
}

/** Wraps one node attempt in a span. Errors are recorded on the span AND rethrown — tracing never swallows a failure. */
export async function withNodeSpan<T>(input: SpanContextInput, fn: () => Promise<T>): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(input.nodeId, async (span: Span) => {
    span.setAttribute('redesign.run_id', input.runId);
    span.setAttribute('redesign.node_id', input.nodeId);
    span.setAttribute('redesign.attempt', input.attempt);
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

/** Reads a run's `trace.jsonl` back in write order — the `trace` CLI command and tests use this. */
export function readSpans(path: string): SpanRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SpanRecord);
}

/** Appends already-finished span records (e.g. buffered in a MemorySpanExporter before the run folder existed) to a `.jsonl` file. */
export function appendSpanRecords(path: string, records: SpanRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}
