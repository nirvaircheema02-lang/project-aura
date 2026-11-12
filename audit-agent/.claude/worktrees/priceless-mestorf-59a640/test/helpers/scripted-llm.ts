import type { LlmClient, LlmRequest, LlmResponse } from '../../src/llm/client.ts';

/**
 * A deterministic stand-in for Claude. It is NOT a mock that returns canned
 * blobs: it derives its answers from the same prompt text a real model would
 * read (refs, roles, types), so the graph's plumbing — ref handling, routing,
 * partitioning, schema validation, evidence flow — is exercised for real.
 *
 * What it does NOT test is model judgment. Every AI node's actual reasoning
 * quality is unverified until a run with real credentials.
 */

export interface ScriptedCall {
  nodeId: string;
  prompt: string;
  images: number;
}

export class ScriptedLlmClient implements LlmClient {
  readonly calls: ScriptedCall[] = [];

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls.push({ nodeId: req.nodeId, prompt: req.prompt, images: req.images?.length ?? 0 });
    const data = this.answer(req);
    // Validate against the node's real schema — a drift between what a node asks
    // for and what this returns should fail loudly here, not silently downstream.
    const parsed = req.schema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`ScriptedLlmClient produced output invalid for ${req.nodeId}: ${parsed.error.message}`);
    }
    return { data: parsed.data, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
  }

  private answer(req: LlmRequest<unknown>): unknown {
    switch (req.nodeId) {
      case 'B1':
        return this.sections(req.prompt);
      case 'B2':
        return this.components(req.prompt);
      case 'B3':
        return this.matches(req.prompt);
      case 'B4':
        return this.expectations(req.prompt);
      case 'B5':
        return this.verdicts(req.prompt);
      case 'B6':
        return this.evaluations(req.prompt);
      case 'A2':
        return this.templates(req.prompt);
      case 'A4':
        return this.rootCauses(req.prompt);
      default:
        throw new Error(`ScriptedLlmClient has no script for node ${req.nodeId}`);
    }
  }

  /** B1 outline lines look like: `e12 region "Hero" [y=0 h=600]` */
  private sections(prompt: string) {
    const lines = [...prompt.matchAll(/^(e\d+) (\w+)(?: "([^"]*)")? \[y=(-?\d+) h=(\d+)\]$/gm)];
    const sections = lines.slice(0, 8).map((m, i) => ({
      name: m[3] || `${m[2]} section ${i + 1}`,
      kind: (m[2] === 'navigation' ? 'nav' : m[2] === 'contentinfo' ? 'footer' : 'content') as 'nav' | 'footer' | 'content',
      rootRef: m[1] as string,
      personalized: /recommended for you/i.test(m[3] ?? ''),
      isListing: false,
      note: 'scripted section',
    }));
    return { sections };
  }

  /** B2 is given raw aria lines containing `[ref=eNN]`. */
  private components(prompt: string) {
    const components: unknown[] = [];
    for (const line of prompt.split('\n')) {
      const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
      if (!ref) continue;
      const role = line.trim().replace(/^-\s*/, '').match(/^([a-zA-Z]+)/)?.[1] ?? '';
      // Named elements carry a quoted accessible name; unnamed ones (a clickable
      // generic div) carry their text after the trailing colon — e.g.
      // `- generic [ref=e9] [cursor=pointer]: Report card one`.
      const name = (line.match(/"((?:[^"\\]|\\.)*)"/)?.[1] ?? line.match(/\]:\s*(.+?)\s*$/)?.[1] ?? '').trim();
      const clickable = line.includes('cursor=pointer');
      let componentType: string | null = null;
      if (role === 'button') componentType = 'button';
      else if (role === 'link') componentType = 'link';
      else if (clickable) componentType = 'card';
      if (!componentType) continue;
      components.push({
        ref,
        componentType,
        label: name,
        domSignals: [`role=${role}`, ...(clickable ? ['cursor=pointer'] : [])],
        visualSignals: 'scripted visual evidence',
        instanceGroupKey: componentType === 'card' ? 'scripted-card' : '',
        confidence: 0.9,
      });
    }
    return { components };
  }

  /** B3 lines look like: `ref=e12 type=button label="..."` */
  private matches(prompt: string) {
    const matches = [...prompt.matchAll(/^ref=(e\d+) type=(\S+)/gm)].map((m) => {
      const type = m[2];
      const isButton = type === 'button';
      return {
        ref: m[1] as string,
        dsComponent: isButton ? 'Button' : null,
        dsVariant: isButton ? 'primary' : null,
        confidence: isButton ? 0.92 : 0.2, // below MEDIUM → S8 routes to B6
        rationale: isButton ? 'scripted: button maps to the DS Button atom' : 'scripted: no DS equivalent',
      };
    });
    return { matches };
  }

  /** B4 blocks look like: `ref=e12 dsComponent=Button dsVariant=primary label="..."` */
  private expectations(prompt: string) {
    const components = [...prompt.matchAll(/^ref=(e\d+) dsComponent=(\S+) dsVariant=(\S+) label="([^"]*)"/gm)].map((m) => {
      const label = m[4] ?? '';
      // The DS says a medium button is --button-height-md and brand red is the CTA fill.
      const expected = [
        { property: 'height', token: '--button-height-md', literal: null, why: 'scripted: Button height comes from the DS size token' },
        { property: 'background-color', token: '--color-brand-red', literal: null, why: 'scripted: brand CTA fill' },
      ];
      // One scripted rule violation, to exercise the INCORRECT path end to end.
      const ruleViolations = /decorative/i.test(label)
        ? [{ ruleId: 'R1.2', title: 'Brand Red is for CTAs ONLY', why: 'scripted: brand red used decoratively, not on a CTA', confidence: 0.9 }]
        : [];
      return { ref: m[1] as string, expected, ruleViolations, confidence: 0.9 };
    });
    return { components };
  }

  private verdicts(prompt: string) {
    const refs = [...prompt.matchAll(/^ref=(e\d+) classification=/gm)].map((m) => m[1] as string);
    return {
      verdicts: refs.map((ref) => ({ ref, verdict: 'CONFIRMED' as const, confidence: 0.9, reasoning: 'scripted: screenshot matches the measurement' })),
      additionalIssues: refs.slice(0, 1).map((ref) => ({
        ref,
        issueType: 'alignment' as const,
        description: 'scripted: control sits 3px below its row baseline',
        severity: 'LOW' as const,
        confidence: 0.8,
      })),
    };
  }

  /** A2 is given a URL inventory; group deterministically by first path segment. */
  private templates(prompt: string) {
    const inventory = prompt.split('URL inventory')[1] ?? '';
    const urls = [...inventory.matchAll(/^(https?:\/\/\S+)$/gm)].map((m) => m[1] as string);
    const byPrefix = new Map<string, string[]>();
    for (const url of urls) {
      const segment = new URL(url).pathname.split('/').filter(Boolean)[0] ?? 'root';
      const key = segment === 'root' ? 'Home' : `${segment[0]!.toUpperCase()}${segment.slice(1)}`;
      byPrefix.set(key, [...(byPrefix.get(key) ?? []), url]);
    }
    return {
      families: [...byPrefix.entries()].map(([name, familyUrls]) => ({
        name,
        urlPattern: name === 'Home' ? '/' : `/${name.toLowerCase()}/*`,
        urls: familyUrls,
        rationale: 'scripted: grouped by first path segment',
      })),
    };
  }

  /** A4 is given already-deduplicated issues, each with `signature=…`. */
  private rootCauses(prompt: string) {
    const signatures = [...prompt.matchAll(/signature=(\S+)/g)].map((m) => m[1] as string);
    if (signatures.length === 0) return { rootCauses: [] };
    return {
      rootCauses: [
        {
          title: 'scripted: one shared component implementation drifts from the Design System',
          issueSignatures: signatures,
          likelyOrigin: 'shared component',
          affectedTemplates: ['Home'],
          recommendation: 'scripted: fix the shared implementation once',
          confidence: 0.8,
        },
      ],
    };
  }

  /** B6 lines look like: `ref=e12 type=card ... instancesOnPage=3 ...` */
  private evaluations(prompt: string) {
    const evaluations = [...prompt.matchAll(/^ref=(e\d+) type=(\S+).*?instancesOnPage=(\d+)/gm)].map((m) => {
      const repeated = Number(m[3]) > 1;
      return {
        ref: m[1] as string,
        verdict: (repeated ? 'DS_CANDIDATE' : 'NEW_COMPONENT') as 'DS_CANDIDATE' | 'NEW_COMPONENT',
        followsDsFoundations: repeated,
        foundationNotes: 'scripted foundation assessment',
        reuseRationale: repeated ? 'scripted: repeated on this page' : 'scripted: single occurrence',
        recommendation: repeated ? 'Consider adding to the Design System' : 'Leave as a one-off pattern',
        confidence: 0.8,
      };
    });
    return { evaluations };
  }
}
