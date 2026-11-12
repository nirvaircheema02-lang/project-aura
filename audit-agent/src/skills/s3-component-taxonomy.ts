import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

/**
 * S3 — Component Taxonomy: canonical names for the component types the
 * detector may emit, plus (scope extended per ARCHITECTURE.md §2.5 rule 3)
 * the content-addressed dedup signature used to group repeated instances and
 * to dedupe DS Candidate proposals across pages and runs.
 */

export const COMPONENT_TYPES = [
  'button', 'link', 'icon-button', 'badge', 'chip', 'tag',
  'card', 'stat', 'metric-tile', 'testimonial', 'accordion', 'tabs', 'table', 'list',
  'input', 'select', 'checkbox', 'radio', 'textarea', 'form', 'search',
  'navbar', 'nav-link', 'breadcrumb', 'footer', 'sidebar', 'pagination',
  'hero', 'section-heading', 'eyebrow', 'paragraph', 'quote', 'image', 'video', 'carousel',
  'modal', 'tooltip', 'banner', 'cta-block', 'chart', 'progress', 'divider', 'avatar', 'logo',
  'unknown',
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export interface SignatureInput {
  componentType: string;
  /** Structural shape, not position — see element-registry's fingerprint. */
  structuralPath: string;
  role: string;
  /** Normalized style facts that define the pattern's identity, not its content. */
  styleFacts: Record<string, string>;
}

/**
 * Strips sibling indices (`div:nth-of-type(3)` → `div`) so that N identical
 * repeated instances — three cards in a grid — collapse to ONE pattern
 * identity. Without this, the dedup index in §2.5 rule 3 would file a
 * separate DS Candidate for every instance of the same pattern, which is
 * precisely what that rule exists to prevent. Element-level identity
 * (finding_id) keeps the full path and is unaffected.
 */
export function patternPath(structuralPath: string): string {
  return structuralPath.replace(/:nth-of-type\(\d+\)/g, '');
}

/**
 * Deterministic signature: canonical JSON (RFC 8785) + sha256, the same
 * discipline D6 uses. Key order can never change the result, so two
 * differently-built objects describing the same pattern collide correctly —
 * which is what makes the `registry_update_requests` UNIQUE index work as
 * dedup rather than as a spurious constraint failure.
 */
export function componentSignature(input: SignatureInput): string {
  const canonical = canonicalize({
    componentType: input.componentType,
    structuralPath: patternPath(input.structuralPath),
    role: input.role,
    styleFacts: input.styleFacts,
  });
  if (canonical === undefined) throw new Error('canonicalize() returned undefined for a component signature');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Off-domain utility links are excluded from detection scope unless they look
 * like a real DS CTA (Part C fix #6): the validated case was a footer
 * "IT Support" link to forms.office.com being evaluated as a DS candidate.
 */
export function isOffDomainUtilityLink(input: { href: string | null; auditedOrigin: string; componentType: string; label: string }): boolean {
  if (!input.href) return false;
  let target: URL;
  try {
    target = new URL(input.href, input.auditedOrigin);
  } catch {
    return false;
  }
  if (target.origin === input.auditedOrigin) return false;
  // A genuine off-site CTA (e.g. "Book a demo" to a scheduling tool) still audits as a CTA.
  const looksLikeCta = /^(button|cta-block)$/.test(input.componentType) || /\b(book|talk|contact|get|start|request|download|subscribe)\b/i.test(input.label);
  return !looksLikeCta;
}
