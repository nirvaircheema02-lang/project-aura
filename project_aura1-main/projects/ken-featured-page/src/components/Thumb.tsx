'use client';

import { useState } from 'react';

/**
 * Shared industry-keyed thumbnail: a content-relevant photo layered over a
 * gradient + line-icon motif. If the photo can't load (offline), the gradient
 * shows through, so cards never look broken. Used by every card style across
 * all 3 layout variants so no two adjacent industries look alike.
 */
// Keyed by the real kenresearch.com/report-store Industries list (14).
const THEME: Record<string, { from: string; to: string; motif: React.ReactNode; imgs: string[] }> = {
  'Food, Beverage and Tobacco': {
    from: '#7a3b1f',
    to: '#431f0f',
    motif: (
      <g>
        <path d="M28 28h28v16a10 10 0 01-10 10H38a10 10 0 01-10-10z" />
        <path d="M56 32h6a6 6 0 010 12h-6" strokeWidth="2.5" fill="none" />
        <path d="M34 20c0-3 3-3 3-6 M42 20c0-3 3-3 3-6 M50 20c0-3 3-3 3-6" strokeWidth="2" fill="none" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1500937386664-56d1dfef3854',
      'https://images.unsplash.com/photo-1560493676-04071c5f467b',
    ],
  },
  'Public Sector and Administration': {
    from: '#1e2f4a',
    to: '#0f1a2c',
    motif: (
      <g>
        <path d="M22 26l22-12 22 12z" />
        <rect x="26" y="28" width="6" height="24" />
        <rect x="41" y="28" width="6" height="24" />
        <rect x="56" y="28" width="6" height="24" />
        <rect x="20" y="52" width="48" height="4" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab',
      'https://images.unsplash.com/photo-1512453979798-5ea266f8880c',
    ],
  },
  'Defense and Security': {
    from: '#33392c',
    to: '#1a1d16',
    motif: <path d="M44 12l20 8v14c0 12-8 20-20 24-12-4-20-12-20-24V20z" strokeWidth="2.5" fill="none" />,
    imgs: [
      'https://images.unsplash.com/photo-1593941707882-a5bba14938c7',
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70',
    ],
  },
  Healthcare: {
    from: '#7a1533',
    to: '#43091d',
    motif: (
      <g>
        <path d="M20 34h12l4-10 6 22 5-16 4 8h12" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d',
      'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d',
    ],
  },
  'Banking Financial Services and Insurance': {
    from: '#0d4b52',
    to: '#072c31',
    motif: (
      <g>
        <path d="M30 46l0-14 M40 46l0-20 M50 46l0-10 M60 46l0-24" strokeWidth="4" strokeLinecap="round" />
        <path d="M26 22l12-6 12 4 12-8" strokeWidth="2.5" fill="none" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3',
      'https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f',
    ],
  },
  'Media and Entertainment': {
    from: '#5c1a4a',
    to: '#310e28',
    motif: (
      <g>
        <rect x="20" y="16" width="48" height="36" rx="4" strokeWidth="2.5" fill="none" />
        <path d="M38 26l14 8-14 8z" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1558494949-ef010cbdcc31',
      'https://images.unsplash.com/photo-1451187580459-43490279c0fa',
    ],
  },
  'Consumer Products and Retail': {
    from: '#5c3a12',
    to: '#33210a',
    motif: (
      <g>
        <path d="M26 24h34l-3 26H29z" />
        <path d="M34 24a7 7 0 0114 0" strokeWidth="2.5" fill="none" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1441986300917-64674bd600d8',
      'https://images.unsplash.com/photo-1567401893414-76b7b1e5a7a5',
    ],
  },
  'Manufacturing and Construction': {
    from: '#4a4038',
    to: '#262019',
    motif: (
      <g>
        <path d="M24 52V30l12 8V30l12 8V22h14v30z" />
        <circle cx="60" cy="16" r="4" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158',
      'https://images.unsplash.com/photo-1565043666747-69f6646db940',
    ],
  },
  'Education and Recruitment': {
    from: '#2a3a6b',
    to: '#16203a',
    motif: (
      <g>
        <path d="M44 18L18 28l26 10 26-10z" />
        <path d="M30 32v10c0 4 6 8 14 8s14-4 14-8V32" strokeWidth="2.5" fill="none" />
        <path d="M64 28v12" strokeWidth="2.5" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab',
      'https://images.unsplash.com/photo-1512453979798-5ea266f8880c',
    ],
  },
  'Automotive, Transportation and Warehousing': {
    from: '#2f3a5f',
    to: '#17203a',
    motif: (
      <g>
        <rect x="20" y="34" width="26" height="18" rx="1.5" />
        <rect x="48" y="34" width="26" height="18" rx="1.5" />
        <rect x="34" y="14" width="26" height="18" rx="1.5" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1494412574643-ff11b0a5c1c3',
      'https://images.unsplash.com/photo-1519003722824-194d4455a60c',
    ],
  },
  'Metal, Mining and Chemicals': {
    from: '#3a3f45',
    to: '#1e2225',
    motif: (
      <g>
        <path d="M38 14h12M40 14v12l-12 22a4 4 0 004 6h24a4 4 0 004-6l-12-22V14" strokeWidth="2.5" fill="none" />
        <path d="M32 42h24" strokeWidth="2" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1509391366360-2e959784a276',
      'https://images.unsplash.com/photo-1466611653911-95081537e5b7',
    ],
  },
  'Energy and Utilities': {
    from: '#0f5132',
    to: '#0a2e20',
    motif: (
      <g>
        <circle cx="47" cy="30" r="10" />
        <path d="M47 6v8 M47 46v8 M23 30h8 M63 30h8 M30 13l6 6 M64 47l-6-6 M64 13l-6 6 M30 47l6-6" strokeWidth="2.5" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1509391366360-2e959784a276',
      'https://images.unsplash.com/photo-1466611653911-95081537e5b7',
    ],
  },
  'Agriculture and Animal Care': {
    from: '#3f5210',
    to: '#233008',
    motif: (
      <g>
        <path d="M43 52V26 M43 34c-8 0-12-6-12-12 8 0 12 6 12 12z M43 30c8 0 12-6 12-12-8 0-12 6-12 12z" strokeWidth="2" fill="none" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1500937386664-56d1dfef3854',
      'https://images.unsplash.com/photo-1560493676-04071c5f467b',
    ],
  },
  'Technology and Telecom': {
    from: '#213a7a',
    to: '#121f45',
    motif: (
      <g>
        <rect x="30" y="22" width="26" height="26" rx="3" />
        <path d="M36 16v6 M46 16v6 M56 22h6 M56 34h6 M56 46h6 M30 22h-6 M30 34h-6 M30 46h-6 M36 48v6 M46 48v6" strokeWidth="2" />
      </g>
    ),
    imgs: [
      'https://images.unsplash.com/photo-1558494949-ef010cbdcc31',
      'https://images.unsplash.com/photo-1451187580459-43490279c0fa',
    ],
  },
};

const FALLBACK = { from: '#26303f', to: '#151b24', motif: <circle cx="44" cy="34" r="12" />, imgs: [] as string[] };

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

export default function Thumb({
  industry,
  id,
  className = 'ccard-thumb',
}: {
  industry: string;
  id: string;
  className?: string;
}) {
  const t = THEME[industry] ?? FALLBACK;
  const url = t.imgs.length ? `${t.imgs[hash(id) % t.imgs.length]}?w=440&h=330&q=70&auto=format&fit=crop` : '';
  const [broken, setBroken] = useState(false);
  return (
    <div className={className}>
      <div className="grad" style={{ background: `linear-gradient(140deg, ${t.from} 0%, ${t.to} 100%)` }} />
      <div className="motif">
        <svg width="88" height="68" viewBox="0 0 88 68" fill="rgba(255,255,255,0.9)" stroke="rgba(255,255,255,0.9)" strokeWidth="0" opacity="0.85">
          {t.motif}
        </svg>
      </div>
      {url && !broken && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
      )}
    </div>
  );
}
