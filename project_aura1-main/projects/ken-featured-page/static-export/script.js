'use strict';
/* ══════════════════════════════════════════════════════════════════════
   Ken Research — Media Citations / Featured In — static vanilla-JS port
   Faithful port of src/components/MediaCitationsPage.tsx + children from
   the Next.js/React source project. No build step, no framework — plain
   DOM APIs only. See static-export/index.html for markup shell.
   ══════════════════════════════════════════════════════════════════════ */

(function () {
  /* ────────────────────────────────────────────────────────────────
     DATA — ported verbatim from src/lib/mock-citations.ts
     ──────────────────────────────────────────────────────────────── */
  const PUBLICATIONS = [
    'Bloomberg', 'Financial Times', 'Yahoo Finance', 'S&P Global', 'TechCrunch',
    'Nikkei Asia', 'Reuters', 'The Economic Times', 'Forbes', 'CNBC',
  ];

  const INDUSTRIES = [
    'Logistics', 'Energy', 'Real Estate', 'Manufacturing', 'BFSI',
    'Healthcare', 'Retail', 'Technology', 'Agriculture', 'Automotive',
  ];

  const REGIONS = [
    'Saudi Arabia', 'GCC', 'India', 'Southeast Asia', 'Africa', 'MENA', 'Global', 'Japan',
  ];

  const TOPICS = [
    'Market Sizing', 'Forecasts', 'Competitive Intelligence', 'Consumer Trends',
    'Policy & Regulation', 'Investment',
  ];

  const YEARS = ['2025', '2024', '2023'];

  const CONTENT_TYPES = [
    'News Article', 'Feature Story', 'Interview', 'Data Highlight', 'Opinion/Column',
  ];

  const HAND = [
    { id: 'c01', publisher: 'Bloomberg', date: 'May 12, 2025', ts: 20250512, title: "Saudi Arabia's logistics boom: How Vision 2030 is reshaping freight", excerpt: 'According to Ken Research, the Saudi Arabia freight & logistics market is projected to surpass USD 38 Bn by 2028, driven by NEOM, Red Sea projects and rising e-commerce penetration.', industry: 'Logistics', region: 'Saudi Arabia', topic: 'Market Sizing', year: '2025', contentType: 'News Article', relatedReport: 'Saudi Arabia Freight & Logistics Market Outlook to 2028', relatedHref: '#', href: '#', popularity: 98 },
    { id: 'c02', publisher: 'Financial Times', date: 'Apr 28, 2025', ts: 20250428, title: 'Renewables push: GCC markets set for accelerated growth', excerpt: 'Ken Research highlights that GCC renewable energy capacity will grow at a double-digit CAGR through 2030, supported by policy reforms and record investment inflows.', industry: 'Energy', region: 'GCC', topic: 'Forecasts', year: '2025', contentType: 'Feature Story', relatedReport: 'GCC Renewable Energy Market Outlook to 2030', relatedHref: '#', href: '#', popularity: 91 },
    { id: 'c03', publisher: 'Yahoo Finance', date: 'Apr 15, 2025', ts: 20250415, title: 'E-commerce expansion driving warehousing demand in India', excerpt: "Ken Research estimates India's warehousing market to exceed USD 31 Bn by 2027, led by e-commerce growth and 3PL investments across tier-2 cities.", industry: 'Real Estate', region: 'India', topic: 'Market Sizing', year: '2025', contentType: 'Interview', relatedReport: 'India Warehousing Market Outlook to 2027', relatedHref: '#', href: '#', popularity: 84 },
    { id: 'c04', publisher: 'S&P Global', date: 'Apr 02, 2025', ts: 20250402, title: 'Manufacturing competitiveness: India emerges as a global hub', excerpt: "Ken Research notes India's manufacturing sector is set to grow strongly, driven by production-linked incentives and resilient export demand.", industry: 'Manufacturing', region: 'India', topic: 'Competitive Intelligence', year: '2025', contentType: 'Data Highlight', relatedReport: 'India Manufacturing Industry Outlook to 2028', relatedHref: '#', href: '#', popularity: 88 },
    { id: 'c05', publisher: 'TechCrunch', date: 'Mar 21, 2025', ts: 20250321, title: 'Southeast Asia fintech funding rebounds on digital-wallet surge', excerpt: 'Ken Research data shows digital payments in Southeast Asia crossing USD 1.1 Tn in transaction value, reshaping the region’s BFSI landscape.', industry: 'BFSI', region: 'Southeast Asia', topic: 'Investment', year: '2025', contentType: 'Opinion/Column', relatedReport: 'Southeast Asia Digital Payments Market Outlook to 2029', relatedHref: '#', href: '#', popularity: 79 },
    { id: 'c06', publisher: 'Nikkei Asia', date: 'Mar 08, 2025', ts: 20250308, title: "Japan's healthcare diagnostics market pivots to AI-led screening", excerpt: 'Ken Research forecasts robust growth in AI-enabled diagnostics across Japan, underpinned by an ageing population and hospital digitisation.', industry: 'Healthcare', region: 'Japan', topic: 'Forecasts', year: '2025', contentType: 'News Article', relatedReport: 'Japan Diagnostics Market Outlook to 2030', relatedHref: '#', href: '#', popularity: 72 },
    { id: 'c07', publisher: 'Reuters', date: 'Feb 26, 2025', ts: 20250226, title: 'African quick-commerce heats up as grocery goes online', excerpt: "Ken Research reports that Africa's online grocery market is scaling rapidly, with quick-commerce players expanding across urban corridors.", industry: 'Retail', region: 'Africa', topic: 'Consumer Trends', year: '2025', contentType: 'Feature Story', relatedReport: 'Africa Online Grocery Retail Market Outlook to 2028', relatedHref: '#', href: '#', popularity: 68 },
    { id: 'c08', publisher: 'The Economic Times', date: 'Feb 11, 2025', ts: 20250211, title: "India's EV supply chain attracts record component investment", excerpt: 'Ken Research highlights surging investment in India’s EV component ecosystem, with localisation reshaping the automotive value chain.', industry: 'Automotive', region: 'India', topic: 'Investment', year: '2025', contentType: 'Interview', relatedReport: 'India EV Components Market Outlook to 2030', relatedHref: '#', href: '#', popularity: 81 },
    { id: 'c09', publisher: 'Forbes', date: 'Jan 29, 2025', ts: 20250129, title: 'Data-centre gold rush: MENA becomes the next cloud frontier', excerpt: 'Ken Research projects a steep rise in MENA data-centre capacity, driven by hyperscaler expansion and sovereign cloud mandates.', industry: 'Technology', region: 'MENA', topic: 'Forecasts', year: '2025', contentType: 'Data Highlight', relatedReport: 'MENA Data Center Market Outlook to 2029', relatedHref: '#', href: '#', popularity: 86 },
    { id: 'c10', publisher: 'CNBC', date: 'Jan 14, 2025', ts: 20250114, title: 'Precision agriculture takes root across Indian farmland', excerpt: 'Ken Research finds rapid adoption of precision-agri technology in India, boosting yields and reshaping the agri-input market.', industry: 'Agriculture', region: 'India', topic: 'Consumer Trends', year: '2025', contentType: 'Opinion/Column', relatedReport: 'India Precision Agriculture Market Outlook to 2028', relatedHref: '#', href: '#', popularity: 64 },
    { id: 'c11', publisher: 'Bloomberg', date: 'Dec 18, 2024', ts: 20241218, title: 'Cold-chain logistics scales up to meet GCC pharma demand', excerpt: 'Ken Research reports accelerating cold-chain investment across the GCC as pharmaceutical and perishable trade volumes climb.', industry: 'Logistics', region: 'GCC', topic: 'Market Sizing', year: '2024', contentType: 'News Article', relatedReport: 'GCC Cold Chain Logistics Market Outlook to 2028', relatedHref: '#', href: '#', popularity: 70 },
    { id: 'c12', publisher: 'Financial Times', date: 'Dec 03, 2024', ts: 20241203, title: 'Green hydrogen ambitions reshape Saudi energy strategy', excerpt: 'Ken Research outlines Saudi Arabia’s green-hydrogen roadmap and its implications for global energy-export competitiveness.', industry: 'Energy', region: 'Saudi Arabia', topic: 'Policy & Regulation', year: '2024', contentType: 'Feature Story', relatedReport: 'Saudi Arabia Green Hydrogen Market Outlook to 2032', relatedHref: '#', href: '#', popularity: 77 },
    { id: 'c13', publisher: 'Reuters', date: 'Nov 20, 2024', ts: 20241120, title: 'Southeast Asia builds out warehousing for a manufacturing shift', excerpt: 'Ken Research data points to a wave of industrial real-estate development across Southeast Asia as supply chains diversify.', industry: 'Real Estate', region: 'Southeast Asia', topic: 'Competitive Intelligence', year: '2024', contentType: 'Interview', relatedReport: 'Southeast Asia Industrial Real Estate Outlook to 2028', relatedHref: '#', href: '#', popularity: 66 },
    { id: 'c14', publisher: 'S&P Global', date: 'Nov 05, 2024', ts: 20241105, title: 'Africa auto assembly gains momentum on local-content rules', excerpt: 'Ken Research highlights growth in African vehicle assembly as governments push local-content policy and industrial incentives.', industry: 'Automotive', region: 'Africa', topic: 'Policy & Regulation', year: '2024', contentType: 'Data Highlight', relatedReport: 'Africa Automotive Manufacturing Outlook to 2029', relatedHref: '#', href: '#', popularity: 59 },
    { id: 'c15', publisher: 'Nikkei Asia', date: 'Oct 22, 2024', ts: 20241022, title: 'Japanese retailers double down on omnichannel investment', excerpt: 'Ken Research finds Japanese retail groups accelerating omnichannel spend to defend margins amid shifting consumer behaviour.', industry: 'Retail', region: 'Japan', topic: 'Consumer Trends', year: '2024', contentType: 'Opinion/Column', relatedReport: 'Japan Omnichannel Retail Market Outlook to 2028', relatedHref: '#', href: '#', popularity: 62 },
    { id: 'c16', publisher: 'TechCrunch', date: 'Oct 07, 2024', ts: 20241007, title: 'Indian SaaS scales globally as enterprise budgets recover', excerpt: 'Ken Research reports India’s SaaS sector expanding into global markets, with strong momentum in vertical and AI-native products.', industry: 'Technology', region: 'India', topic: 'Forecasts', year: '2024', contentType: 'News Article', relatedReport: 'India SaaS Market Outlook to 2030', relatedHref: '#', href: '#', popularity: 83 },
    { id: 'c17', publisher: 'Forbes', date: 'Sep 19, 2024', ts: 20240919, title: 'GCC wealth-management market matures as HNWI base widens', excerpt: 'Ken Research notes a broadening high-net-worth base across the GCC, driving demand for advisory and digital wealth platforms.', industry: 'BFSI', region: 'GCC', topic: 'Investment', year: '2024', contentType: 'Feature Story', relatedReport: 'GCC Wealth Management Market Outlook to 2029', relatedHref: '#', href: '#', popularity: 71 },
    { id: 'c18', publisher: 'CNBC', date: 'Sep 04, 2024', ts: 20240904, title: 'MENA agritech funding surges amid food-security push', excerpt: 'Ken Research highlights rising agritech investment across MENA as governments prioritise food security and water efficiency.', industry: 'Agriculture', region: 'MENA', topic: 'Investment', year: '2024', contentType: 'Interview', relatedReport: 'MENA AgriTech Market Outlook to 2029', relatedHref: '#', href: '#', popularity: 57 },
    { id: 'c19', publisher: 'The Economic Times', date: 'Aug 21, 2024', ts: 20240821, title: "India's hospital chains expand into tier-2 and tier-3 cities", excerpt: 'Ken Research reports accelerating hospital-chain expansion into smaller Indian cities, backed by private-equity capital.', industry: 'Healthcare', region: 'India', topic: 'Market Sizing', year: '2024', contentType: 'Data Highlight', relatedReport: 'India Hospital Market Outlook to 2028', relatedHref: '#', href: '#', popularity: 74 },
    { id: 'c20', publisher: 'Yahoo Finance', date: 'Aug 06, 2024', ts: 20240806, title: 'Global port automation reshapes container-handling economics', excerpt: 'Ken Research examines how automation at major global ports is lowering handling costs and redefining competitiveness.', industry: 'Logistics', region: 'Global', topic: 'Competitive Intelligence', year: '2024', contentType: 'Opinion/Column', relatedReport: 'Global Port Automation Market Outlook to 2030', relatedHref: '#', href: '#', popularity: 69 },
    { id: 'c21', publisher: 'Bloomberg', date: 'Jul 18, 2024', ts: 20240718, title: 'Solar manufacturing capacity races ahead in India', excerpt: 'Ken Research forecasts a sharp rise in India’s solar-module manufacturing capacity, supported by incentives and export demand.', industry: 'Manufacturing', region: 'India', topic: 'Forecasts', year: '2024', contentType: 'News Article', relatedReport: 'India Solar Manufacturing Market Outlook to 2030', relatedHref: '#', href: '#', popularity: 80 },
    { id: 'c22', publisher: 'Reuters', date: 'Jun 25, 2024', ts: 20240625, title: 'Saudi real-estate giga-projects redraw the investment map', excerpt: 'Ken Research analyses how Saudi giga-projects are attracting global capital and reshaping regional real-estate demand.', industry: 'Real Estate', region: 'Saudi Arabia', topic: 'Investment', year: '2024', contentType: 'Feature Story', relatedReport: 'Saudi Arabia Real Estate Market Outlook to 2029', relatedHref: '#', href: '#', popularity: 85 },
    { id: 'c23', publisher: 'Financial Times', date: 'May 30, 2024', ts: 20240530, title: 'African fintech consolidation accelerates cross-border payments', excerpt: 'Ken Research reports a wave of fintech consolidation in Africa, streamlining cross-border payments and remittance flows.', industry: 'BFSI', region: 'Africa', topic: 'Competitive Intelligence', year: '2024', contentType: 'Interview', relatedReport: 'Africa Fintech Market Outlook to 2028', relatedHref: '#', href: '#', popularity: 63 },
    { id: 'c24', publisher: 'Forbes', date: 'Nov 09, 2023', ts: 20231109, title: 'EV charging networks scale rapidly across the GCC', excerpt: 'Ken Research highlights fast-growing EV-charging infrastructure across the GCC as adoption incentives take hold.', industry: 'Automotive', region: 'GCC', topic: 'Policy & Regulation', year: '2023', contentType: 'Data Highlight', relatedReport: 'GCC EV Charging Infrastructure Outlook to 2028', relatedHref: '#', href: '#', popularity: 55 },
    { id: 'c25', publisher: 'CNBC', date: 'Oct 12, 2023', ts: 20231012, title: 'Southeast Asian cloud spend outpaces global average', excerpt: 'Ken Research finds cloud spending in Southeast Asia growing faster than the global average, led by digital-first enterprises.', industry: 'Technology', region: 'Southeast Asia', topic: 'Forecasts', year: '2023', contentType: 'Opinion/Column', relatedReport: 'Southeast Asia Cloud Computing Market Outlook to 2029', relatedHref: '#', href: '#', popularity: 60 },
  ];

  // ── Deterministic generator for additional entries (index-based, no
  // Math.random/Date.now — matches the source module's determinism guarantee). ──
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const TITLE_TPL = [
    (r, ind) => `${r} ${ind} sector poised for structural growth, Ken Research finds`,
    (r, ind) => `Why ${r}'s ${ind.toLowerCase()} market is entering a new growth phase`,
    (r, ind) => `${ind} investment accelerates across ${r} as demand climbs`,
    (r, ind, y) => `Ken Research: ${r} ${ind.toLowerCase()} outlook strengthens through ${y}`,
    (r, ind) => `${r} ${ind} players eye expansion amid shifting demand`,
    (r, ind) => `Data check: ${r}'s ${ind.toLowerCase()} market by the numbers`,
  ];

  const EXC_TPL = [
    (r, ind, t, y) => `Ken Research projects the ${r} ${ind.toLowerCase()} market to expand meaningfully through ${y}, citing ${t.toLowerCase()} as the primary growth driver.`,
    (r, ind, t) => `New Ken Research data shows ${r}'s ${ind.toLowerCase()} sector gaining momentum, with ${t.toLowerCase()} reshaping competitive dynamics.`,
    (r, ind, t) => `According to Ken Research, ${r} ${ind.toLowerCase()} demand is set to rise steadily, underpinned by ${t.toLowerCase()} and shifting buyer behavior.`,
  ];

  function genCitations(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const pub = PUBLICATIONS[i % PUBLICATIONS.length];
      const ind = INDUSTRIES[(i * 3 + 1) % INDUSTRIES.length];
      const reg = REGIONS[(i * 5 + 2) % REGIONS.length];
      const top = TOPICS[(i * 7 + 3) % TOPICS.length];
      const yr = YEARS[(i * 2) % YEARS.length];
      const ct = CONTENT_TYPES[(i * 11) % CONTENT_TYPES.length];
      const monthIdx = (i * 4) % 12;
      const day = 3 + ((i * 9) % 26);
      const date = `${MONTHS[monthIdx]} ${String(day).padStart(2, '0')}, ${yr}`;
      const ts = Number(yr) * 10000 + (monthIdx + 1) * 100 + day;
      const title = TITLE_TPL[i % TITLE_TPL.length](reg, ind, yr);
      const excerpt = EXC_TPL[i % EXC_TPL.length](reg, ind, top, yr);
      const reportYear = Number(yr) + 4;
      out.push({
        id: `g${String(i + 1).padStart(2, '0')}`,
        publisher: pub, date, ts, title, excerpt,
        industry: ind, region: reg, topic: top, year: yr, contentType: ct,
        relatedReport: `${reg} ${ind} Market Outlook to ${reportYear}`,
        relatedHref: '#', href: '#',
        popularity: 38 + ((i * 13) % 58),
      });
    }
    return out;
  }

  const CITATIONS = [...HAND, ...genCitations(50)];

  /* ────────────────────────────────────────────────────────────────
     THUMB — ported verbatim from src/components/Thumb.tsx (THEME map
     + hash()). SVG motifs kept as raw markup strings so cards still
     vary visually by industry/id exactly like the source.
     ──────────────────────────────────────────────────────────────── */
  const THEME = {
    Logistics: { from: '#1f3a5f', to: '#0f2038', motif: '<rect x="20" y="34" width="26" height="18" rx="1.5"/><rect x="48" y="34" width="26" height="18" rx="1.5"/><rect x="34" y="14" width="26" height="18" rx="1.5"/>', imgs: ['https://images.unsplash.com/photo-1494412574643-ff11b0a5c1c3', 'https://images.unsplash.com/photo-1519003722824-194d4455a60c'] },
    Energy: { from: '#0f5132', to: '#0a2e20', motif: '<circle cx="47" cy="30" r="10"/><path d="M47 6v8 M47 46v8 M23 30h8 M63 30h8 M30 13l6 6 M64 47l-6-6 M64 13l-6 6 M30 47l6-6" stroke-width="2.5"/>', imgs: ['https://images.unsplash.com/photo-1509391366360-2e959784a276', 'https://images.unsplash.com/photo-1466611653911-95081537e5b7'] },
    'Real Estate': { from: '#3b2f63', to: '#211a3a', motif: '<rect x="24" y="24" width="16" height="30"/><rect x="44" y="14" width="16" height="40"/><path d="M28 30h8 M28 38h8 M48 22h8 M48 30h8 M48 38h8" stroke-width="2"/>', imgs: ['https://images.unsplash.com/photo-1486406146926-c627a92ad1ab', 'https://images.unsplash.com/photo-1512453979798-5ea266f8880c'] },
    Manufacturing: { from: '#5a3410', to: '#331c08', motif: '<path d="M24 52V30l12 8V30l12 8V22h14v30z"/><circle cx="60" cy="16" r="4"/>', imgs: ['https://images.unsplash.com/photo-1581091226825-a6a2a5aee158', 'https://images.unsplash.com/photo-1565043666747-69f6646db940'] },
    BFSI: { from: '#0d4b52', to: '#072c31', motif: '<path d="M30 46l0-14 M40 46l0-20 M50 46l0-10 M60 46l0-24" stroke-width="4" stroke-linecap="round"/><path d="M26 22l12-6 12 4 12-8" stroke-width="2.5" fill="none"/>', imgs: ['https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3', 'https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f'] },
    Healthcare: { from: '#7a1533', to: '#43091d', motif: '<path d="M20 34h12l4-10 6 22 5-16 4 8h12" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>', imgs: ['https://images.unsplash.com/photo-1576091160399-112ba8d25d1d', 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d'] },
    Retail: { from: '#5c3a12', to: '#33210a', motif: '<path d="M26 24h34l-3 26H29z"/><path d="M34 24a7 7 0 0114 0" stroke-width="2.5" fill="none"/>', imgs: ['https://images.unsplash.com/photo-1441986300917-64674bd600d8', 'https://images.unsplash.com/photo-1567401893414-76b7b1e5a7a5'] },
    Technology: { from: '#213a7a', to: '#121f45', motif: '<rect x="30" y="22" width="26" height="26" rx="3"/><path d="M36 16v6 M46 16v6 M56 22h6 M56 34h6 M56 46h6 M30 22h-6 M30 34h-6 M30 46h-6 M36 48v6 M46 48v6" stroke-width="2"/>', imgs: ['https://images.unsplash.com/photo-1558494949-ef010cbdcc31', 'https://images.unsplash.com/photo-1451187580459-43490279c0fa'] },
    Agriculture: { from: '#3f5210', to: '#233008', motif: '<path d="M43 52V26 M43 34c-8 0-12-6-12-12 8 0 12 6 12 12z M43 30c8 0 12-6 12-12-8 0-12 6-12 12z" stroke-width="2" fill="none"/>', imgs: ['https://images.unsplash.com/photo-1500937386664-56d1dfef3854', 'https://images.unsplash.com/photo-1560493676-04071c5f467b'] },
    Automotive: { from: '#4a2a5e', to: '#291635', motif: '<path d="M22 42l4-12h34l6 12" stroke-width="2.5" fill="none" stroke-linejoin="round"/><rect x="20" y="42" width="48" height="6" rx="2"/><circle cx="32" cy="50" r="4"/><circle cx="56" cy="50" r="4"/>', imgs: ['https://images.unsplash.com/photo-1593941707882-a5bba14938c7', 'https://images.unsplash.com/photo-1503376780353-7e6692767b70'] },
  };
  const FALLBACK_THEME = { from: '#26303f', to: '#151b24', motif: '<circle cx="44" cy="34" r="12"/>', imgs: [] };

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function thumbHTML(industry, id, className) {
    const t = THEME[industry] || FALLBACK_THEME;
    const url = t.imgs.length ? `${t.imgs[hash(id) % t.imgs.length]}?w=440&h=330&q=70&auto=format&fit=crop` : '';
    const img = url
      ? `<img src="${url}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : '';
    return (
      `<div class="${className}">` +
      `<div class="grad" style="background:linear-gradient(140deg, ${t.from} 0%, ${t.to} 100%)"></div>` +
      `<div class="motif"><svg width="88" height="68" viewBox="0 0 88 68" fill="rgba(255,255,255,0.9)" stroke="rgba(255,255,255,0.9)" stroke-width="0" opacity="0.85">${t.motif}</svg></div>` +
      img +
      `</div>`
    );
  }

  /* ────────────────────────────────────────────────────────────────
     FILTER / SORT LOGIC — ported verbatim from MediaCitationsPage.tsx
     ──────────────────────────────────────────────────────────────── */
  const DIMENSIONS = [
    { key: 'publisher', label: 'Publication', options: PUBLICATIONS },
    { key: 'region', label: 'Region / Geography', options: REGIONS },
    { key: 'industry', label: 'Industry', options: INDUSTRIES },
    { key: 'year', label: 'Year', options: YEARS },
    { key: 'topic', label: 'Topic', options: TOPICS },
    { key: 'contentType', label: 'Content Type', options: CONTENT_TYPES },
  ];

  const SORTS = [
    { value: 'recent', label: 'Most Recent' },
    { value: 'popular', label: 'Most Popular' },
    { value: 'publication', label: 'Publication A-Z' },
    { value: 'year', label: 'Year' },
  ];

  function emptyFilters() {
    return { publisher: [], region: [], industry: [], year: [], topic: [], contentType: [] };
  }

  const fieldOf = (c, key) => c[key];

  function matches(c, filters, query, ignoreKey) {
    for (const dim of DIMENSIONS) {
      if (dim.key === ignoreKey) continue;
      const sel = filters[dim.key];
      if (sel && sel.length && !sel.includes(fieldOf(c, dim.key))) return false;
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      const hay = `${c.title} ${c.excerpt} ${c.publisher} ${c.relatedReport} ${c.industry} ${c.region} ${c.topic}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ────────────────────────────────────────────────────────────────
     STATE — mirrors the useState calls in MediaCitationsPage.tsx
     ──────────────────────────────────────────────────────────────── */
  const state = {
    variant: 'design2',
    filters: emptyFilters(),
    query: '',
    sort: 'recent',
    pageSize: 10,
    page: 1,
    drawerOpen: false,
    // independent accordion open-state per FilterGroup instance (desktop
    // sidebar vs mobile drawer render two separate instances in the source)
    groupOpen: {
      sidebar: Object.fromEntries(DIMENSIONS.map((d, i) => [d.key, i === 0])),
      drawer: Object.fromEntries(DIMENSIONS.map((d, i) => [d.key, i === 0])),
    },
  };

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ────────────────────────────────────────────────────────────────
     DERIVED DATA
     ──────────────────────────────────────────────────────────────── */
  function computeFiltered() {
    const list = CITATIONS.filter((c) => matches(c, state.filters, state.query));
    const s = list.slice();
    switch (state.sort) {
      case 'popular':
        s.sort((a, b) => b.popularity - a.popularity);
        break;
      case 'publication':
        s.sort((a, b) => a.publisher.localeCompare(b.publisher) || b.ts - a.ts);
        break;
      case 'year':
        s.sort((a, b) => Number(b.year) - Number(a.year) || b.ts - a.ts);
        break;
      default:
        s.sort((a, b) => b.ts - a.ts);
    }
    return s;
  }

  function computeCounts() {
    const out = {};
    for (const dim of DIMENSIONS) {
      const base = CITATIONS.filter((c) => matches(c, state.filters, state.query, dim.key));
      out[dim.key] = {};
      for (const opt of dim.options) {
        out[dim.key][opt] = base.filter((c) => fieldOf(c, dim.key) === opt).length;
      }
    }
    return out;
  }

  function computePageNums(totalPages, safePage) {
    const nums = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) nums.push(i);
    } else {
      nums.push(1);
      if (safePage > 3) nums.push('ell');
      for (let i = Math.max(2, safePage - 1); i <= Math.min(totalPages - 1, safePage + 1); i++) nums.push(i);
      if (safePage < totalPages - 2) nums.push('ell');
      nums.push(totalPages);
    }
    return nums;
  }

  const activeCount = () => Object.values(state.filters).reduce((n, arr) => n + arr.length, 0);

  const activeChips = () => {
    const chips = [];
    for (const dim of DIMENSIONS) {
      for (const value of state.filters[dim.key] || []) chips.push({ key: dim.key, value, label: value });
    }
    return chips;
  };

  /* ────────────────────────────────────────────────────────────────
     ICONS (inline SVG strings — match the source's inline <svg> JSX)
     ──────────────────────────────────────────────────────────────── */
  const ICON = {
    chevDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"/></svg>',
    arrowUpRight: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
    arrowUpRightSm: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
    close: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    reset: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><polyline points="3 3 3 8 8 8"/></svg>',
    prev: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    next: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  };

  /* ────────────────────────────────────────────────────────────────
     RENDER: Filter group / sidebar / drawer body
     (ports FilterSidebar.tsx + MobileFilterDrawer.tsx)
     ──────────────────────────────────────────────────────────────── */
  function renderFilterGroup(dim, context) {
    const selected = state.filters[dim.key] || [];
    const counts = computeCounts()[dim.key] || {};
    const open = state.groupOpen[context][dim.key];
    let body = '';
    if (open) {
      body =
        '<div class="fsb-body">' +
        dim.options
          .map((opt) => {
            const checked = selected.includes(opt);
            const count = counts[opt] || 0;
            return (
              '<label class="fsb-opt">' +
              `<input type="checkbox" data-dim="${dim.key}" data-value="${escapeHtml(opt)}" data-ctx="${context}" ${checked ? 'checked' : ''} />` +
              `<span class="fsb-box">${ICON.check}</span>` +
              `<span class="fsb-txt">${escapeHtml(opt)}</span>` +
              `<span class="fsb-count">${count}</span>` +
              '</label>'
            );
          })
          .join('') +
        '</div>';
    }
    return (
      '<div class="fsb-grp">' +
      `<button type="button" class="fsb-trig" aria-expanded="${open}" data-toggle-group="${dim.key}" data-ctx="${context}">` +
      escapeHtml(dim.label) +
      `<span class="chev">${ICON.chevDown}</span>` +
      '</button>' +
      body +
      '</div>'
    );
  }

  function renderSidebar() {
    const el = document.getElementById('filterSidebar');
    if (!el) return;
    const count = activeCount();
    el.innerHTML =
      '<div class="fsb-hd"><h3>Filters</h3>' +
      (count > 0
        ? `<button type="button" class="fsb-reset" id="fsbReset">${ICON.reset}Clear all</button>`
        : '') +
      '</div>' +
      DIMENSIONS.map((dim) => renderFilterGroup(dim, 'sidebar')).join('');
  }

  function renderDrawerBody() {
    const body = document.getElementById('drawerBody');
    if (!body) return;
    body.innerHTML = DIMENSIONS.map((dim) => renderFilterGroup(dim, 'drawer')).join('');
    const showBtn = document.getElementById('drawerShow');
    const filtered = computeFiltered();
    if (showBtn) showBtn.textContent = `Show ${filtered.length} result${filtered.length === 1 ? '' : 's'}`;
  }

  /* ────────────────────────────────────────────────────────────────
     RENDER: citation cards (CitationRowWide.tsx / CitationGridCard.tsx)
     ──────────────────────────────────────────────────────────────── */
  function renderCard(c, index, variant) {
    const delay = (Math.min(index, 6) * 0.05).toFixed(2);
    if (variant === 'design3') {
      return (
        `<article class="egrid-card reveal" style="transition-delay:${delay}s">` +
        '<div class="egrid-thumb-wrap">' +
        thumbHTML(c.industry, c.id, 'egrid-thumb') +
        `<span class="egrid-badge">${escapeHtml(c.contentType)}</span>` +
        '</div>' +
        '<div class="egrid-body">' +
        '<div class="ccard-top">' +
        `<span class="ccard-pub">${escapeHtml(c.publisher)}</span><span class="dot"></span><span>${escapeHtml(c.date)}</span>` +
        '</div>' +
        `<h3 class="egrid-ttl">${escapeHtml(c.title)}</h3>` +
        `<p class="egrid-exc">${escapeHtml(c.excerpt)}</p>` +
        '<div class="ccard-tags">' +
        `<span class="ctag">${escapeHtml(c.industry)}</span><span class="ctag">${escapeHtml(c.topic)}</span>` +
        '</div>' +
        '<div class="egrid-source-wrap"><hr class="egrid-divider" />' +
        '<div class="egrid-source"><p class="egrid-source-lbl">Source Report</p>' +
        `<a class="egrid-source-rel" href="${c.relatedHref}">${escapeHtml(c.relatedReport)}</a></div>` +
        `<a class="ccard-cta" href="${c.href}">Learn More${ICON.arrowUpRightSm}</a>` +
        '</div></div></article>'
      );
    }
    const boxed = variant === 'design1';
    return (
      `<article class="crow-wide${boxed ? ' crow-wide--card' : ''} reveal" style="transition-delay:${delay}s">` +
      thumbHTML(c.industry, c.id, 'crow-wide-thumb') +
      '<div class="crow-wide-body">' +
      '<div class="ccard-top">' +
      `<span class="ccard-pub">${escapeHtml(c.publisher)}</span><span class="dot"></span><span>${escapeHtml(c.date)}</span>` +
      `<span class="dot"></span><span class="ccard-ctype">${escapeHtml(c.contentType)}</span>` +
      '</div>' +
      `<h3 class="ccard-ttl">${escapeHtml(c.title)}</h3>` +
      `<p class="ccard-exc">${escapeHtml(c.excerpt)}</p>` +
      '<div class="ccard-tags">' +
      `<span class="ctag">${escapeHtml(c.industry)}</span><span class="ctag">${escapeHtml(c.region)}</span><span class="ctag">${escapeHtml(c.topic)}</span>` +
      '</div></div>' +
      '<div class="crow-wide-side">' +
      '<div class="crow-side-block"><p class="crow-side-lbl">Source Report</p>' +
      `<a class="crow-side-rel" href="${c.relatedHref}">${escapeHtml(c.relatedReport)}</a></div>` +
      `<a class="ccard-cta" href="${c.href}">Learn More${ICON.arrowUpRight}</a>` +
      '</div></article>'
    );
  }

  let cardObserver = null;
  function observeReveals(root) {
    if (cardObserver) cardObserver.disconnect();
    const els = root.querySelectorAll('.reveal');
    if (reduceMotion()) {
      els.forEach((el) => el.classList.add('in-view'));
      return;
    }
    cardObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            cardObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0, rootMargin: '0px 0px -8% 0px' }
    );
    els.forEach((el) => cardObserver.observe(el));
  }

  /* ────────────────────────────────────────────────────────────────
     RENDER: listing (result count, chips, list, pagination)
     ──────────────────────────────────────────────────────────────── */
  function renderListing() {
    const filtered = computeFiltered();
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    const safePage = Math.min(state.page, totalPages);
    const start = (safePage - 1) * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);

    // result count
    const rescount = document.getElementById('rescount');
    rescount.innerHTML = `<b>${filtered.length}</b> citation${filtered.length === 1 ? '' : 's'} found`;

    // mobile filter badge
    const badge = document.getElementById('mfilterBadge');
    const count = activeCount();
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = String(count);
    } else {
      badge.hidden = true;
    }

    // applied-filter chips
    const chipRow = document.getElementById('chipRow');
    const chips = activeChips();
    if (chips.length > 0) {
      chipRow.hidden = false;
      chipRow.innerHTML =
        chips
          .map(
            (chip) =>
              `<button type="button" class="chip" data-chip-key="${chip.key}" data-chip-value="${escapeHtml(chip.value)}">${escapeHtml(chip.label)}${ICON.close}</button>`
          )
          .join('') + '<button type="button" class="chip-clear" id="chipClear">Clear all</button>';
    } else {
      chipRow.hidden = true;
      chipRow.innerHTML = '';
    }

    // card list
    const listEl = document.getElementById('citationList');
    listEl.className = state.variant === 'design3' ? 'egrid' : 'clist';
    if (pageItems.length > 0) {
      listEl.innerHTML = pageItems.map((c, i) => renderCard(c, i, state.variant)).join('');
      observeReveals(listEl);
    } else {
      listEl.className = '';
      listEl.innerHTML =
        '<div class="empty"><h4>No citations found</h4>' +
        '<p>Try adjusting or clearing your filters to see more results.</p>' +
        '<button type="button" id="emptyReset">Clear all filters</button></div>';
    }

    // pagination
    const pag = document.getElementById('pagination');
    if (totalPages > 1) {
      pag.hidden = false;
      const nums = computePageNums(totalPages, safePage);
      pag.innerHTML =
        `<button type="button" class="pag-btn" data-page="${safePage - 1}" ${safePage === 1 ? 'disabled' : ''}>${ICON.prev}Prev</button>` +
        nums
          .map((n, i) =>
            n === 'ell'
              ? `<span class="pag-ell" key="e${i}">…</span>`
              : `<button type="button" class="pag-btn${n === safePage ? ' on' : ''}" data-page="${n}" ${n === safePage ? 'aria-current="page"' : ''}>${n}</button>`
          )
          .join('') +
        `<button type="button" class="pag-btn" data-page="${safePage + 1}" ${safePage === totalPages ? 'disabled' : ''}>Next${ICON.next}</button>`;
    } else {
      pag.hidden = true;
      pag.innerHTML = '';
    }

    renderSidebar();
    if (state.drawerOpen) renderDrawerBody();
  }

  /* ────────────────────────────────────────────────────────────────
     RENDER: variant switch (hero + listing layout classes)
     ──────────────────────────────────────────────────────────────── */
  function applyVariantLayout() {
    // hero sections
    document.getElementById('hero-design1').hidden = state.variant !== 'design1';
    document.getElementById('hero-design2').hidden = state.variant !== 'design2';
    document.getElementById('hero-design3').hidden = state.variant !== 'design3';

    // tabs
    document.querySelectorAll('.vtab').forEach((btn) => {
      const on = btn.dataset.variant === state.variant;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', String(on));
    });

    // listing layout
    const listingSection = document.getElementById('listingSection');
    listingSection.className = 'listing' + (state.variant === 'design2' ? ' listing--white' : '');
    const listingIn = document.getElementById('listingIn');
    const isDesign3 = state.variant === 'design3';
    listingIn.className = 'listing-in' + (isDesign3 ? ' no-sidebar' : '');

    document.getElementById('filterSidebar').hidden = isDesign3;
    document.getElementById('mfilterBtn').hidden = isDesign3;

    if (isDesign3 && state.drawerOpen) closeDrawer();
  }

  function triggerHeroEntrance() {
    // re-run the "mount" fade/slide for the now-visible hero (mirrors framer's
    // initial/animate on each hero component + its stagger on Design 1's cards)
    const active = document.getElementById(`hero-design${state.variant.slice(-1)}`);
    if (!active) return;
    const els = active.querySelectorAll('.reveal');
    els.forEach((el) => el.classList.remove('in-view'));
    // force reflow so the removed class actually resets the transition
    void active.offsetWidth;
    requestAnimationFrame(() => {
      els.forEach((el) => el.classList.add('in-view'));
    });
  }

  function switchVariant(next) {
    if (next === state.variant) return;
    const fadeWrap = document.getElementById('variantFade');
    const doSwitch = () => {
      state.variant = next;
      state.page = 1;
      applyVariantLayout();
      renderListing();
      triggerHeroEntrance();
      fadeWrap.classList.remove('fading');
    };
    if (reduceMotion()) {
      doSwitch();
      return;
    }
    fadeWrap.classList.add('fading');
    window.setTimeout(doSwitch, 280);
  }

  /* ────────────────────────────────────────────────────────────────
     PAGINATION / SCROLL
     ──────────────────────────────────────────────────────────────── */
  function goTo(p) {
    state.page = p;
    renderListing();
    document.querySelector('.listing').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ────────────────────────────────────────────────────────────────
     FILTER / SEARCH / SORT ACTIONS
     ──────────────────────────────────────────────────────────────── */
  function toggleFilter(key, value) {
    const cur = state.filters[key] || [];
    state.filters[key] = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    state.page = 1;
    renderListing();
  }

  function resetFilters() {
    state.filters = emptyFilters();
    state.query = '';
    document.getElementById('searchInput').value = '';
    state.page = 1;
    renderListing();
  }

  /* ────────────────────────────────────────────────────────────────
     MOBILE DRAWER (MobileFilterDrawer.tsx)
     ──────────────────────────────────────────────────────────────── */
  let prevBodyOverflow = '';
  function openDrawer() {
    state.drawerOpen = true;
    document.getElementById('drawerScrim').classList.add('open');
    const drawer = document.getElementById('drawer');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.getElementById('drawerScrim').style.pointerEvents = 'auto';
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    renderDrawerBody();
    document.addEventListener('keydown', onDrawerKeydown);
  }
  function closeDrawer() {
    state.drawerOpen = false;
    document.getElementById('drawerScrim').classList.remove('open');
    document.getElementById('drawerScrim').style.pointerEvents = 'none';
    const drawer = document.getElementById('drawer');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = prevBodyOverflow;
    document.removeEventListener('keydown', onDrawerKeydown);
  }
  function onDrawerKeydown(e) {
    if (e.key === 'Escape') closeDrawer();
  }

  /* ────────────────────────────────────────────────────────────────
     STICKY CTA (StickyCTA.tsx) — scroll threshold + IntersectionObserver
     handoff + sessionStorage dismissal
     ──────────────────────────────────────────────────────────────── */
  const DISMISS_KEY = 'kfp-sticky-cta-dismissed';
  const stickyState = { dismissed: true, pastThreshold: false, nearFinalCta: false };

  function updateStickyVisibility() {
    const show = !stickyState.dismissed && stickyState.pastThreshold && !stickyState.nearFinalCta;
    const el = document.getElementById('stickyCta');
    const inner = document.getElementById('stickyCtaIn');
    el.setAttribute('aria-hidden', String(!show));
    inner.classList.toggle('show', show);
    inner.style.pointerEvents = show ? 'auto' : 'none';
  }

  function initStickyCta() {
    try {
      stickyState.dismissed = sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      stickyState.dismissed = false;
    }

    let ticking = false;
    const updateScroll = () => {
      const y = window.scrollY;
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      const pct = docH > 0 ? y / docH : 0;
      stickyState.pastThreshold = pct > 0.3 || y > window.innerHeight * 0.9;
      ticking = false;
      updateStickyVisibility();
    };
    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(updateScroll);
      },
      { passive: true }
    );
    updateScroll();

    const finalCta = document.getElementById('finalCtaAnchor');
    if (finalCta) {
      const obs = new IntersectionObserver(
        ([entry]) => {
          stickyState.nearFinalCta = entry.isIntersecting;
          updateStickyVisibility();
        },
        { rootMargin: '0px 0px 120px 0px' }
      );
      obs.observe(finalCta);
    }

    document.getElementById('stickyCtaClose').addEventListener('click', () => {
      stickyState.dismissed = true;
      try {
        sessionStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* sessionStorage unavailable — dismissal just won't persist */
      }
      updateStickyVisibility();
    });

    updateStickyVisibility();
  }

  /* ────────────────────────────────────────────────────────────────
     BOTTOM CTA fade-in (BottomCTA.tsx: useInView amount:0.3, once)
     ──────────────────────────────────────────────────────────────── */
  function initBottomCta() {
    const el = document.getElementById('bottomCtaIn');
    if (!el) return;
    if (reduceMotion()) {
      el.classList.add('in-view');
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            el.classList.add('in-view');
            obs.unobserve(el);
          }
        });
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
  }

  /* ────────────────────────────────────────────────────────────────
     PUBLICATIONS CAROUSEL (PublicationsCarousel.tsx) — rAF auto-scroll,
     duplicated list for seamless loop, pause on hover/touch
     ──────────────────────────────────────────────────────────────── */
  function initPublicationsCarousel() {
    const track = document.getElementById('pubcarTrack');
    if (!track) return;
    if (reduceMotion()) return;
    let paused = false;
    track.addEventListener('mouseenter', () => (paused = true));
    track.addEventListener('mouseleave', () => (paused = false));
    track.addEventListener('touchstart', () => (paused = true), { passive: true });
    track.addEventListener('touchend', () => (paused = false));
    const step = () => {
      if (!paused) {
        track.scrollLeft += 0.45;
        const half = track.scrollWidth / 2;
        if (track.scrollLeft >= half) track.scrollLeft -= half;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ────────────────────────────────────────────────────────────────
     DESIGN 1 HERO PREVIEW CARDS (top 4 by popularity) — depends on
     CITATIONS, so rendered from script.js rather than hardcoded HTML
     ──────────────────────────────────────────────────────────────── */
  function renderHeroDesign1Preview() {
    const stack = document.getElementById('glassStack');
    if (!stack) return;
    const topFour = CITATIONS.slice().sort((a, b) => b.popularity - a.popularity).slice(0, 4);
    stack.innerHTML = topFour
      .map(
        (c, i) =>
          `<a class="glass-card reveal" href="${c.href}" style="transition-delay:${(0.15 + i * 0.08).toFixed(2)}s">` +
          '<div class="glass-top">' +
          `<span class="glass-pub">${escapeHtml(c.publisher)}</span><span class="glass-date">${escapeHtml(c.date)}</span>` +
          '</div>' +
          `<p class="glass-ttl">${escapeHtml(c.title)}</p>` +
          '<span class="glass-arrow" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></span>' +
          '</a>'
      )
      .join('');
  }

  /* ────────────────────────────────────────────────────────────────
     EVENT DELEGATION — one listener per event type on document, keeps
     re-rendered DOM (sidebar/list/drawer) wired without re-attaching
     ──────────────────────────────────────────────────────────────── */
  function attachDelegatedEvents() {
    document.addEventListener('click', (e) => {
      const tab = e.target.closest('.vtab');
      if (tab) {
        switchVariant(tab.dataset.variant);
        return;
      }
      const trig = e.target.closest('[data-toggle-group]');
      if (trig) {
        const key = trig.dataset.toggleGroup;
        const ctx = trig.dataset.ctx;
        state.groupOpen[ctx][key] = !state.groupOpen[ctx][key];
        if (ctx === 'sidebar') renderSidebar();
        else renderDrawerBody();
        return;
      }
      if (e.target.closest('#fsbReset')) {
        resetFilters();
        return;
      }
      const chip = e.target.closest('.chip[data-chip-key]');
      if (chip) {
        toggleFilter(chip.dataset.chipKey, chip.dataset.chipValue);
        return;
      }
      if (e.target.closest('#chipClear') || e.target.closest('#emptyReset')) {
        resetFilters();
        return;
      }
      const pageBtn = e.target.closest('.pag-btn');
      if (pageBtn && !pageBtn.disabled) {
        goTo(Number(pageBtn.dataset.page));
        return;
      }
      if (e.target.closest('#mfilterBtn')) {
        openDrawer();
        return;
      }
      if (e.target.closest('#drawerClose') || e.target.closest('#drawerScrim')) {
        closeDrawer();
        return;
      }
      if (e.target.closest('#drawerReset')) {
        resetFilters();
        renderDrawerBody();
        return;
      }
      if (e.target.closest('#drawerShow')) {
        closeDrawer();
        return;
      }
    });

    document.addEventListener('change', (e) => {
      const checkbox = e.target.closest('input[type="checkbox"][data-dim]');
      if (checkbox) {
        toggleFilter(checkbox.dataset.dim, checkbox.dataset.value);
        return;
      }
      if (e.target.id === 'sortSelect') {
        state.sort = e.target.value;
        state.page = 1;
        renderListing();
        return;
      }
      if (e.target.id === 'pageSizeSelect') {
        state.pageSize = Number(e.target.value);
        state.page = 1;
        renderListing();
        return;
      }
    });

    document.getElementById('searchInput').addEventListener('input', (e) => {
      state.query = e.target.value;
      state.page = 1;
      renderListing();
    });
  }

  /* ────────────────────────────────────────────────────────────────
     INIT
     ──────────────────────────────────────────────────────────────── */
  function init() {
    renderHeroDesign1Preview();
    applyVariantLayout();
    renderListing();
    attachDelegatedEvents();
    initPublicationsCarousel();
    initBottomCta();
    initStickyCta();

    // initial mount entrance (mirrors framer's `animate` on first paint)
    requestAnimationFrame(() => {
      document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in-view'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
