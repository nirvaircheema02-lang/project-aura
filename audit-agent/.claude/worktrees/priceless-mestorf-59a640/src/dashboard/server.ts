import { readFile, readdir, stat } from 'node:fs/promises';
import { dashboardBuildId } from './build-id.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { renderProjectsIndex, renderRun, renderRunsIndex } from './views/render.ts';
import type { AuditData } from '../agents/c2-json-writer/index.ts';

/**
 * C4 — Local Audit Dashboard (ARCHITECTURE.md §6, Decision Log #18/#20/#21).
 *
 * - Reads C2's `data.json` per request. It computes no aggregate of its own,
 *   so it cannot drift from Excel or Figma (Decision Log #19).
 * - READ-ONLY: there is no route that writes anything, and the process never
 *   opens a run file for writing.
 * - ONE long-running server for every project and run (Decision Log #20), not
 *   one per run. It is NOT a run-scoped graph node, which is why it lives in
 *   src/dashboard/ rather than src/agents/ (Decision Log #21).
 */

export const SERVICE_ID = 'ken-audit-agent-dashboard';

export interface DashboardOptions {
  projectsRoot: string;
  logger?: boolean;
}

async function readAuditData(projectsRoot: string, project: string, runId: string): Promise<AuditData | null> {
  const path = join(projectsRoot, project, 'runs', runId, 'data.json');
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as AuditData;
}

async function listRuns(projectsRoot: string, project: string): Promise<string[]> {
  const runsDir = join(projectsRoot, project, 'runs');
  if (!existsSync(runsDir)) return [];
  const entries = await readdir(runsDir, { withFileTypes: true });
  const runs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  // Newest first, by directory mtime — run ids are opaque, so time is the honest ordering.
  const withTime = await Promise.all(runs.map(async (r) => ({ r, t: (await stat(join(runsDir, r))).mtimeMs })));
  return withTime.sort((a, b) => b.t - a.t).map((x) => x.r);
}

async function listProjects(projectsRoot: string): Promise<string[]> {
  if (!existsSync(projectsRoot)) return [];
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Rejects any path segment that could escape the projects root. */
function safeSegment(value: string): string | null {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..' ? value : null;
}

export async function buildDashboard(options: DashboardOptions): Promise<FastifyInstance> {
  // projectNameFor (run-store.ts) has no length cap — it's hostname + full URL path, slugified.
  // find-my-way's default maxParamLength (100) silently fails to match anything longer, which
  // reads as a plain 404 with no indication why. Raised well past any real-world slug we've seen.
  const app = Fastify({ logger: options.logger ?? false, routerOptions: { maxParamLength: 300 } });
  const { projectsRoot } = options;

  await app.register(fastifyStatic, { root: projectsRoot, prefix: '/evidence/', decorateReply: false, index: false });

  /** Used by the CLI to tell "our dashboard is already up" from "something else owns this port". */
  // build + projectsRoot + pid let the launcher tell "our current server" from a stale one.
  const build = dashboardBuildId();
  app.get('/health', async () => ({ service: SERVICE_ID, projectsRoot, build, pid: process.pid, ok: true }));

  app.get('/', async (_req, reply) => {
    const names = await listProjects(projectsRoot);
    const projects = await Promise.all(
      names.map(async (name) => {
        const runs = await listRuns(projectsRoot, name);
        let targetUrl = '';
        const projectFile = join(projectsRoot, name, 'project.json');
        if (existsSync(projectFile)) targetUrl = (JSON.parse(await readFile(projectFile, 'utf-8')) as { targetUrl: string }).targetUrl;
        return { name, runs, targetUrl };
      }),
    );
    return reply.type('text/html; charset=utf-8').send(renderProjectsIndex(projects));
  });

  app.get<{ Params: { project: string } }>('/projects/:project', async (req, reply) => {
    const project = safeSegment(req.params.project);
    if (!project) return reply.code(400).send('invalid project name');
    const runIds = await listRuns(projectsRoot, project);
    const runs = await Promise.all(
      runIds.map(async (runId) => {
        const data = await readAuditData(projectsRoot, project, runId);
        return { runId, startedAt: data?.run.startedAt ?? null, compliance: data?.websiteSummary.compliancePercent ?? null };
      }),
    );
    return reply.type('text/html; charset=utf-8').send(renderRunsIndex(project, runs));
  });

  app.get<{ Params: { project: string; runId: string } }>('/projects/:project/runs/:runId', async (req, reply) => {
    const project = safeSegment(req.params.project);
    const runId = safeSegment(req.params.runId);
    if (!project || !runId) return reply.code(400).send('invalid project or run id');
    const data = await readAuditData(projectsRoot, project, runId);
    if (!data) return reply.code(404).type('text/html; charset=utf-8').send('<p>No data.json for this run yet.</p>');
    const evidenceBase = `/evidence/${encodeURIComponent(project)}/runs/${encodeURIComponent(runId)}/screenshots`;
    return reply.type('text/html; charset=utf-8').send(renderRun(project, data, evidenceBase));
  });

  /** The same canonical data the page renders from, for scripted checks. */
  app.get<{ Params: { project: string; runId: string } }>('/projects/:project/runs/:runId/api/data', async (req, reply) => {
    const project = safeSegment(req.params.project);
    const runId = safeSegment(req.params.runId);
    if (!project || !runId) return reply.code(400).send({ error: 'invalid project or run id' });
    const data = await readAuditData(projectsRoot, project, runId);
    if (!data) return reply.code(404).send({ error: 'not found' });
    return data;
  });

  return app;
}

export async function startDashboard(options: DashboardOptions & { port: number; host?: string }): Promise<FastifyInstance> {
  const app = await buildDashboard(options);
  await app.listen({ port: options.port, host: options.host ?? '127.0.0.1' });
  return app;
}

// Direct execution: `node --experimental-strip-types src/dashboard/server.ts`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=src\/)/, ''))) {
  const { loadConfig } = await import('../config/index.ts');
  const config = loadConfig();
  const projectsRoot = process.env.AUDIT_AGENT_PROJECTS_ROOT ?? join(process.cwd(), 'projects');
  const app = await startDashboard({ projectsRoot, port: config.dashboardPort, logger: true });
  app.log.info(`audit dashboard on http://localhost:${config.dashboardPort} serving ${projectsRoot}`);
}
