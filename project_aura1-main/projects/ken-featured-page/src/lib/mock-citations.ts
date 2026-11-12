// Mock media-citation dataset for the Ken Research "Media Citations / Featured In"
// page. 25 hand-authored entries + 50 deterministically generated ones (75 total,
// 8 pages at 10/page or 4 at 20/page) spread across every filter dimension so each
// facet has real, non-trivial counts. Thumbnails are industry-keyed so no two
// adjacent cards look alike. Copy is illustrative; replace with real citations.
// Generation is index-based (no Math.random/Date.now) so server + client renders
// match exactly — this module is imported on both sides.

export type Citation = {
  id: string;
  publisher: string;
  date: string; // display string
  ts: number; // sort key (epoch-ish, higher = newer)
  title: string;
  excerpt: string;
  industry: string;
  region: string;
  topic: string;
  year: string;
  contentType: string;
  relatedReport: string;
  relatedHref: string;
  href: string;
  popularity: number; // drives "Most Popular"
};

export const PUBLICATIONS = [
  'Bloomberg',
  'Financial Times',
  'Yahoo Finance',
  'S&P Global',
  'TechCrunch',
  'Nikkei Asia',
  'Reuters',
  'The Economic Times',
  'Forbes',
  'CNBC',
];

// Matches the real kenresearch.com/report-store Industries filter exactly (14).
export const INDUSTRIES = [
  'Food, Beverage and Tobacco',
  'Public Sector and Administration',
  'Defense and Security',
  'Healthcare',
  'Banking Financial Services and Insurance',
  'Media and Entertainment',
  'Consumer Products and Retail',
  'Manufacturing and Construction',
  'Education and Recruitment',
  'Automotive, Transportation and Warehousing',
  'Metal, Mining and Chemicals',
  'Energy and Utilities',
  'Agriculture and Animal Care',
  'Technology and Telecom',
];

export const REGIONS = [
  'Saudi Arabia',
  'GCC',
  'India',
  'Southeast Asia',
  'Africa',
  'MENA',
  'Global',
  'Japan',
];

export const TOPICS = [
  'Market Sizing',
  'Forecasts',
  'Competitive Intelligence',
  'Consumer Trends',
  'Policy & Regulation',
  'Investment',
];

export const YEARS = ['2025', '2024', '2023'];

export const CONTENT_TYPES = [
  'News Article',
  'Feature Story',
  'Interview',
  'Data Highlight',
  'Opinion/Column',
];

const HAND: Citation[] = [
  {
    id: 'c01',
    publisher: 'Bloomberg',
    date: 'May 12, 2025',
    ts: 20250512,
    title: "Saudi Arabia's logistics boom: How Vision 2030 is reshaping freight",
    excerpt:
      'According to Ken Research, the Saudi Arabia freight & logistics market is projected to surpass USD 38 Bn by 2028, driven by NEOM, Red Sea projects and rising e-commerce penetration.',
    industry: 'Automotive, Transportation and Warehousing',
    region: 'Saudi Arabia',
    topic: 'Market Sizing',
    year: '2025',
    contentType: 'News Article',
    relatedReport: 'Saudi Arabia Freight & Logistics Market Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 98,
  },
  {
    id: 'c02',
    publisher: 'Financial Times',
    date: 'Apr 28, 2025',
    ts: 20250428,
    title: 'Renewables push: GCC markets set for accelerated growth',
    excerpt:
      'Ken Research highlights that GCC renewable energy capacity will grow at a double-digit CAGR through 2030, supported by policy reforms and record investment inflows.',
    industry: 'Energy and Utilities',
    region: 'GCC',
    topic: 'Forecasts',
    year: '2025',
    contentType: 'Feature Story',
    relatedReport: 'GCC Renewable Energy Market Outlook to 2030',
    relatedHref: '#',
    href: '#',
    popularity: 91,
  },
  {
    id: 'c03',
    publisher: 'Yahoo Finance',
    date: 'Apr 15, 2025',
    ts: 20250415,
    title: 'E-commerce expansion driving warehousing demand in India',
    excerpt:
      "Ken Research estimates India's warehousing market to exceed USD 31 Bn by 2027, led by e-commerce growth and 3PL investments across tier-2 cities.",
    industry: 'Manufacturing and Construction',
    region: 'India',
    topic: 'Market Sizing',
    year: '2025',
    contentType: 'Interview',
    relatedReport: 'India Warehousing Market Outlook to 2027',
    relatedHref: '#',
    href: '#',
    popularity: 84,
  },
  {
    id: 'c04',
    publisher: 'S&P Global',
    date: 'Apr 02, 2025',
    ts: 20250402,
    title: 'Manufacturing competitiveness: India emerges as a global hub',
    excerpt:
      "Ken Research notes India's manufacturing sector is set to grow strongly, driven by production-linked incentives and resilient export demand.",
    industry: 'Manufacturing and Construction',
    region: 'India',
    topic: 'Competitive Intelligence',
    year: '2025',
    contentType: 'Data Highlight',
    relatedReport: 'India Manufacturing Industry Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 88,
  },
  {
    id: 'c05',
    publisher: 'TechCrunch',
    date: 'Mar 21, 2025',
    ts: 20250321,
    title: 'Southeast Asia fintech funding rebounds on digital-wallet surge',
    excerpt:
      'Ken Research data shows digital payments in Southeast Asia crossing USD 1.1 Tn in transaction value, reshaping the region’s BFSI landscape.',
    industry: 'Banking Financial Services and Insurance',
    region: 'Southeast Asia',
    topic: 'Investment',
    year: '2025',
    contentType: 'Opinion/Column',
    relatedReport: 'Southeast Asia Digital Payments Market Outlook to 2029',
    relatedHref: '#',
    href: '#',
    popularity: 79,
  },
  {
    id: 'c06',
    publisher: 'Nikkei Asia',
    date: 'Mar 08, 2025',
    ts: 20250308,
    title: "Japan's healthcare diagnostics market pivots to AI-led screening",
    excerpt:
      'Ken Research forecasts robust growth in AI-enabled diagnostics across Japan, underpinned by an ageing population and hospital digitisation.',
    industry: 'Healthcare',
    region: 'Japan',
    topic: 'Forecasts',
    year: '2025',
    contentType: 'News Article',
    relatedReport: 'Japan Diagnostics Market Outlook to 2030',
    relatedHref: '#',
    href: '#',
    popularity: 72,
  },
  {
    id: 'c07',
    publisher: 'Reuters',
    date: 'Feb 26, 2025',
    ts: 20250226,
    title: 'African quick-commerce heats up as grocery goes online',
    excerpt:
      "Ken Research reports that Africa's online grocery market is scaling rapidly, with quick-commerce players expanding across urban corridors.",
    industry: 'Consumer Products and Retail',
    region: 'Africa',
    topic: 'Consumer Trends',
    year: '2025',
    contentType: 'Feature Story',
    relatedReport: 'Africa Online Grocery Retail Market Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 68,
  },
  {
    id: 'c08',
    publisher: 'The Economic Times',
    date: 'Feb 11, 2025',
    ts: 20250211,
    title: "India's EV supply chain attracts record component investment",
    excerpt:
      'Ken Research highlights surging investment in India’s EV component ecosystem, with localisation reshaping the automotive value chain.',
    industry: 'Automotive, Transportation and Warehousing',
    region: 'India',
    topic: 'Investment',
    year: '2025',
    contentType: 'Interview',
    relatedReport: 'India EV Components Market Outlook to 2030',
    relatedHref: '#',
    href: '#',
    popularity: 81,
  },
  {
    id: 'c09',
    publisher: 'Forbes',
    date: 'Jan 29, 2025',
    ts: 20250129,
    title: 'Data-centre gold rush: MENA becomes the next cloud frontier',
    excerpt:
      'Ken Research projects a steep rise in MENA data-centre capacity, driven by hyperscaler expansion and sovereign cloud mandates.',
    industry: 'Technology and Telecom',
    region: 'MENA',
    topic: 'Forecasts',
    year: '2025',
    contentType: 'Data Highlight',
    relatedReport: 'MENA Data Center Market Outlook to 2029',
    relatedHref: '#',
    href: '#',
    popularity: 86,
  },
  {
    id: 'c10',
    publisher: 'CNBC',
    date: 'Jan 14, 2025',
    ts: 20250114,
    title: 'Precision agriculture takes root across Indian farmland',
    excerpt:
      'Ken Research finds rapid adoption of precision-agri technology in India, boosting yields and reshaping the agri-input market.',
    industry: 'Agriculture and Animal Care',
    region: 'India',
    topic: 'Consumer Trends',
    year: '2025',
    contentType: 'Opinion/Column',
    relatedReport: 'India Precision Agriculture Market Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 64,
  },
  {
    id: 'c11',
    publisher: 'Bloomberg',
    date: 'Dec 18, 2024',
    ts: 20241218,
    title: 'Cold-chain logistics scales up to meet GCC pharma demand',
    excerpt:
      'Ken Research reports accelerating cold-chain investment across the GCC as pharmaceutical and perishable trade volumes climb.',
    industry: 'Automotive, Transportation and Warehousing',
    region: 'GCC',
    topic: 'Market Sizing',
    year: '2024',
    contentType: 'News Article',
    relatedReport: 'GCC Cold Chain Logistics Market Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 70,
  },
  {
    id: 'c12',
    publisher: 'Financial Times',
    date: 'Dec 03, 2024',
    ts: 20241203,
    title: 'Green hydrogen ambitions reshape Saudi energy strategy',
    excerpt:
      'Ken Research outlines Saudi Arabia’s green-hydrogen roadmap and its implications for global energy-export competitiveness.',
    industry: 'Energy and Utilities',
    region: 'Saudi Arabia',
    topic: 'Policy & Regulation',
    year: '2024',
    contentType: 'Feature Story',
    relatedReport: 'Saudi Arabia Green Hydrogen Market Outlook to 2032',
    relatedHref: '#',
    href: '#',
    popularity: 77,
  },
  {
    id: 'c13',
    publisher: 'Reuters',
    date: 'Nov 20, 2024',
    ts: 20241120,
    title: 'Southeast Asia builds out warehousing for a manufacturing shift',
    excerpt:
      'Ken Research data points to a wave of industrial real-estate development across Southeast Asia as supply chains diversify.',
    industry: 'Manufacturing and Construction',
    region: 'Southeast Asia',
    topic: 'Competitive Intelligence',
    year: '2024',
    contentType: 'Interview',
    relatedReport: 'Southeast Asia Industrial Real Estate Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 66,
  },
  {
    id: 'c14',
    publisher: 'S&P Global',
    date: 'Nov 05, 2024',
    ts: 20241105,
    title: 'Africa auto assembly gains momentum on local-content rules',
    excerpt:
      'Ken Research highlights growth in African vehicle assembly as governments push local-content policy and industrial incentives.',
    industry: 'Automotive, Transportation and Warehousing',
    region: 'Africa',
    topic: 'Policy & Regulation',
    year: '2024',
    contentType: 'Data Highlight',
    relatedReport: 'Africa Automotive Manufacturing Outlook to 2029',
    relatedHref: '#',
    href: '#',
    popularity: 59,
  },
  {
    id: 'c15',
    publisher: 'Nikkei Asia',
    date: 'Oct 22, 2024',
    ts: 20241022,
    title: 'Japanese retailers double down on omnichannel investment',
    excerpt:
      'Ken Research finds Japanese retail groups accelerating omnichannel spend to defend margins amid shifting consumer behaviour.',
    industry: 'Consumer Products and Retail',
    region: 'Japan',
    topic: 'Consumer Trends',
    year: '2024',
    contentType: 'Opinion/Column',
    relatedReport: 'Japan Omnichannel Retail Market Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 62,
  },
  {
    id: 'c16',
    publisher: 'TechCrunch',
    date: 'Oct 07, 2024',
    ts: 20241007,
    title: 'Indian SaaS scales globally as enterprise budgets recover',
    excerpt:
      'Ken Research reports India’s SaaS sector expanding into global markets, with strong momentum in vertical and AI-native products.',
    industry: 'Technology and Telecom',
    region: 'India',
    topic: 'Forecasts',
    year: '2024',
    contentType: 'News Article',
    relatedReport: 'India SaaS Market Outlook to 2030',
    relatedHref: '#',
    href: '#',
    popularity: 83,
  },
  {
    id: 'c17',
    publisher: 'Forbes',
    date: 'Sep 19, 2024',
    ts: 20240919,
    title: 'GCC wealth-management market matures as HNWI base widens',
    excerpt:
      'Ken Research notes a broadening high-net-worth base across the GCC, driving demand for advisory and digital wealth platforms.',
    industry: 'Banking Financial Services and Insurance',
    region: 'GCC',
    topic: 'Investment',
    year: '2024',
    contentType: 'Feature Story',
    relatedReport: 'GCC Wealth Management Market Outlook to 2029',
    relatedHref: '#',
    href: '#',
    popularity: 71,
  },
  {
    id: 'c18',
    publisher: 'CNBC',
    date: 'Sep 04, 2024',
    ts: 20240904,
    title: 'MENA agritech funding surges amid food-security push',
    excerpt:
      'Ken Research highlights rising agritech investment across MENA as governments prioritise food security and water efficiency.',
    industry: 'Agriculture and Animal Care',
    region: 'MENA',
    topic: 'Investment',
    year: '2024',
    contentType: 'Interview',
    relatedReport: 'MENA AgriTech Market Outlook to 2029',
    relatedHref: '#',
    href: '#',
    popularity: 57,
  },
  {
    id: 'c19',
    publisher: 'The Economic Times',
    date: 'Aug 21, 2024',
    ts: 20240821,
    title: "India's hospital chains expand into tier-2 and tier-3 cities",
    excerpt:
      'Ken Research reports accelerating hospital-chain expansion into smaller Indian cities, backed by private-equity capital.',
    industry: 'Healthcare',
    region: 'India',
    topic: 'Market Sizing',
    year: '2024',
    contentType: 'Data Highlight',
    relatedReport: 'India Hospital Market Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 74,
  },
  {
    id: 'c20',
    publisher: 'Yahoo Finance',
    date: 'Aug 06, 2024',
    ts: 20240806,
    title: 'Global port automation reshapes container-handling economics',
    excerpt:
      'Ken Research examines how automation at major global ports is lowering handling costs and redefining competitiveness.',
    industry: 'Automotive, Transportation and Warehousing',
    region: 'Global',
    topic: 'Competitive Intelligence',
    year: '2024',
    contentType: 'Opinion/Column',
    relatedReport: 'Global Port Automation Market Outlook to 2030',
    relatedHref: '#',
    href: '#',
    popularity: 69,
  },
  {
    id: 'c21',
    publisher: 'Bloomberg',
    date: 'Jul 18, 2024',
    ts: 20240718,
    title: 'Solar manufacturing capacity races ahead in India',
    excerpt:
      'Ken Research forecasts a sharp rise in India’s solar-module manufacturing capacity, supported by incentives and export demand.',
    industry: 'Manufacturing and Construction',
    region: 'India',
    topic: 'Forecasts',
    year: '2024',
    contentType: 'News Article',
    relatedReport: 'India Solar Manufacturing Market Outlook to 2030',
    relatedHref: '#',
    href: '#',
    popularity: 80,
  },
  {
    id: 'c22',
    publisher: 'Reuters',
    date: 'Jun 25, 2024',
    ts: 20240625,
    title: 'Saudi real-estate giga-projects redraw the investment map',
    excerpt:
      'Ken Research analyses how Saudi giga-projects are attracting global capital and reshaping regional real-estate demand.',
    industry: 'Manufacturing and Construction',
    region: 'Saudi Arabia',
    topic: 'Investment',
    year: '2024',
    contentType: 'Feature Story',
    relatedReport: 'Saudi Arabia Real Estate Market Outlook to 2029',
    relatedHref: '#',
    href: '#',
    popularity: 85,
  },
  {
    id: 'c23',
    publisher: 'Financial Times',
    date: 'May 30, 2024',
    ts: 20240530,
    title: 'African fintech consolidation accelerates cross-border payments',
    excerpt:
      'Ken Research reports a wave of fintech consolidation in Africa, streamlining cross-border payments and remittance flows.',
    industry: 'Banking Financial Services and Insurance',
    region: 'Africa',
    topic: 'Competitive Intelligence',
    year: '2024',
    contentType: 'Interview',
    relatedReport: 'Africa Fintech Market Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 63,
  },
  {
    id: 'c24',
    publisher: 'Forbes',
    date: 'Nov 09, 2023',
    ts: 20231109,
    title: 'EV charging networks scale rapidly across the GCC',
    excerpt:
      'Ken Research highlights fast-growing EV-charging infrastructure across the GCC as adoption incentives take hold.',
    industry: 'Automotive, Transportation and Warehousing',
    region: 'GCC',
    topic: 'Policy & Regulation',
    year: '2023',
    contentType: 'Data Highlight',
    relatedReport: 'GCC EV Charging Infrastructure Outlook to 2028',
    relatedHref: '#',
    href: '#',
    popularity: 55,
  },
  {
    id: 'c25',
    publisher: 'CNBC',
    date: 'Oct 12, 2023',
    ts: 20231012,
    title: 'Southeast Asian cloud spend outpaces global average',
    excerpt:
      'Ken Research finds cloud spending in Southeast Asia growing faster than the global average, led by digital-first enterprises.',
    industry: 'Technology and Telecom',
    region: 'Southeast Asia',
    topic: 'Forecasts',
    year: '2023',
    contentType: 'Opinion/Column',
    relatedReport: 'Southeast Asia Cloud Computing Market Outlook to 2029',
    relatedHref: '#',
    href: '#',
    popularity: 60,
  },
];

// ── Deterministic generator for additional entries (index-based, no Math.random
// or Date.now — this module runs on both server and client, so the output must
// be identical every time or React hydration mismatches). ──────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TITLE_TPL: Array<(r: string, ind: string, y: string) => string> = [
  (r, ind) => `${r} ${ind} sector poised for structural growth, Ken Research finds`,
  (r, ind) => `Why ${r}'s ${ind.toLowerCase()} market is entering a new growth phase`,
  (r, ind) => `${ind} investment accelerates across ${r} as demand climbs`,
  (r, ind, y) => `Ken Research: ${r} ${ind.toLowerCase()} outlook strengthens through ${y}`,
  (r, ind) => `${r} ${ind} players eye expansion amid shifting demand`,
  (r, ind) => `Data check: ${r}'s ${ind.toLowerCase()} market by the numbers`,
];

const EXC_TPL: Array<(r: string, ind: string, t: string, y: string) => string> = [
  (r, ind, t, y) =>
    `Ken Research projects the ${r} ${ind.toLowerCase()} market to expand meaningfully through ${y}, citing ${t.toLowerCase()} as the primary growth driver.`,
  (r, ind, t) =>
    `New Ken Research data shows ${r}'s ${ind.toLowerCase()} sector gaining momentum, with ${t.toLowerCase()} reshaping competitive dynamics.`,
  (r, ind, t) =>
    `According to Ken Research, ${r} ${ind.toLowerCase()} demand is set to rise steadily, underpinned by ${t.toLowerCase()} and shifting buyer behavior.`,
];

function genCitations(count: number): Citation[] {
  const out: Citation[] = [];
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
      publisher: pub,
      date,
      ts,
      title,
      excerpt,
      industry: ind,
      region: reg,
      topic: top,
      year: yr,
      contentType: ct,
      relatedReport: `${reg} ${ind} Market Outlook to ${reportYear}`,
      relatedHref: '#',
      href: '#',
      popularity: 38 + ((i * 13) % 58),
    });
  }
  return out;
}

export const CITATIONS: Citation[] = [...HAND, ...genCitations(50)];
