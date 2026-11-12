import { IMAGES } from "./constants.js";

/* ════════════════════════════════════════════════════════════
   ⚑ EDIT ME — These are YOUR real projects.
   Keep it honest: 3 live websites + 2 UI/UX projects.
   Replace title / description / img / industry / link with the
   real details. Set `liveUrl` to the real site to show a "Visit
   live site" button on the case-study page.
═══════════════════════════════════════════════════════════════ */

export const PROJECTS = [
  /* ───────── LIVE WEBSITE — Arjun Realty ───────── */
  {
    slug: "arjun-realty",
    label: "Live Website",
    category: "Website Design & UI/UX",
    title: "Arjun Realty — Luxury Real Estate",
    description: "UI/UX and website design for a premium real estate brand in Gurgaon, showcasing luxury residences and investment opportunities.",
    summary: "A complete UI/UX and website design for Arjun Realty — a premium real estate brand in Gurgaon. Designed to showcase luxury developments, build investor trust, and drive consultation enquiries, then built as a live, responsive website.",
    industry: "Real Estate · Gurgaon",
    outcome: "Gave serious buyers a clear route to a consultation.",
    img: "/work/arjun-1.webp",
    liveUrl: "https://arjunrealty.in/",
    status: "Live",
    timeline: "UI/UX + Website",
    services: ["UI/UX Design", "Website Design & Development", "Responsive Build", "Design System"],
    challenge: "A premium real estate brand needs to feel trustworthy and high-end instantly, present several luxury developments clearly, and make it easy for serious buyers and investors to enquire.",
    delivered: ["Luxury brand-led UI/UX design", "Home, About, project detail & contact pages", "Featured developments showcase", "Enquiry & consultation flow", "Responsive website build", "Consistent navy + gold visual system"],
    decisions: [
      { title: "Premium first impression", desc: "A dark navy hero with refined gold accents and full-bleed imagery sets a luxury tone from the first scroll." },
      { title: "Developments front and centre", desc: "Curated residence cards make it easy to browse and open detailed project pages." },
      { title: "Clear enquiry path", desc: "'Schedule Consultation' and 'Enquire Now' stay within reach for serious buyers." },
    ],
    results: ["Live, responsive real-estate website delivered", "Premium, trustworthy brand presentation", "Clear path from browsing to enquiry"],
    gallery: [
      { kind: "desktop", label: "Home",           img: "/work/arjun-1.webp" },
      { kind: "desktop", label: "About",          img: "/work/arjun-2.webp" },
      { kind: "desktop", label: "Project Detail", img: "/work/arjun-3.webp" },
      { kind: "desktop", label: "Contact",        img: "/work/arjun-4.webp" },
    ],
    isReal: true,
    featured: true,
  },

  /* ───────── LIVE WEBSITE — Amrit Studio ───────── */
  {
    slug: "amrit-studio",
    label: "Live Website",
    category: "Website Design & UI/UX",
    title: "Amrit Studio — Photography",
    description: "UI/UX and website design for a premium couples & wedding photography studio, built around timeless visuals and storytelling.",
    summary: "A premium website experience for Amrit Studio — a photography studio that crafts timeless images for couples. The design leads with warm, editorial visuals and a clear 'capture your story' journey, built as a live, responsive site.",
    industry: "Photography Studio",
    outcome: "Rebuilt the site around the photography, with one booking action.",
    img: "/work/amrit-1.webp",
    liveUrl: "https://www.amritstudio.in/",
    status: "Live",
    timeline: "UI/UX + Website",
    services: ["UI/UX Design", "Website Design & Development", "Responsive Build", "Visual Direction"],
    challenge: "A premium photography studio needs the website itself to feel like its work — warm, editorial, and emotional — while still guiding visitors clearly toward booking.",
    delivered: ["Editorial, image-led UI/UX design", "Home, services, about & blog flows", "Story-driven hero and CTAs", "Responsive website build", "Consistent warm visual tone"],
    decisions: [
      { title: "Let the work lead", desc: "Full-bleed photography and generous space put the studio's craft front and centre." },
      { title: "Emotion before features", desc: "Storytelling copy and a single 'Capture Your Story' CTA guide the visitor gently." },
      { title: "Warm, premium tone", desc: "A restrained warm palette and refined type keep the experience editorial." },
    ],
    results: ["Live, responsive photography website delivered", "Warm, story-led brand experience", "Clear path from browsing to enquiry"],
    gallery: [
      { kind: "desktop", label: "Home",          img: "/work/amrit-1.webp" },
      { kind: "desktop", label: "About & Craft",  img: "/work/amrit-2.webp" },
      { kind: "desktop", label: "Portfolio",      img: "/work/amrit-3.webp" },
    ],
    isReal: true,
    featured: true,
  },

  /* ───────── UI/UX PROJECT — 25Colleges ───────── */
  {
    slug: "uiux-25colleges",
    label: "UI/UX Project",
    category: "UI/UX Design",
    title: "25Colleges — Study Abroad Platform",
    description: "End-to-end UI/UX design for an international study-abroad platform serving students, recruitment partners, and institutions.",
    summary: "A complete UI/UX design for 25Colleges — an international education platform that helps students find programs, lets recruitment partners grow, and gives institutions global reach. Eight connected page flows under one consistent visual system.",
    industry: "EdTech · Study Abroad",
    outcome: "Unified three audience journeys into one design system.",
    img: "/work/uiux-1.webp",
    liveUrl: "",
    status: "Design completed",
    timeline: "UI/UX design",
    services: ["UI/UX Design", "Web Platform Design", "Design System", "Wireframing", "Visual Design"],
    challenge: "25Colleges had to speak to three very different audiences — students, recruitment partners, and institutions — across many pages, without the experience feeling fragmented or overwhelming.",
    delivered: [
      "End-to-end web platform UI (8 page flows)",
      "Home and program-finder experience",
      "Recruitment partner and institution pages",
      "Services, events, and blog layouts",
      "Sign up / login flows",
      "Reusable, consistent component system",
      "Responsive desktop layouts",
    ],
    decisions: [
      { title: "One system, three audiences", desc: "A shared navy + gold visual language keeps the student, partner, and institution journeys consistent while each gets its own focused page." },
      { title: "Guided discovery", desc: "A program finder and clear subject filters help students search thousands of programs without feeling lost." },
      { title: "Trust through proof", desc: "Stats, success stories, and clear value props sit on every audience page to build credibility quickly." },
    ],
    results: [
      "Complete multi-audience platform designed",
      "Clear, consistent navigation across all sections",
      "Reusable design system applied end-to-end",
    ],
    gallery: [
      { kind: "desktop", label: "Home",                 img: "/work/uiux-1.webp" },
      { kind: "desktop", label: "Find Your Program",     img: "/work/uiux-2.webp" },
      { kind: "desktop", label: "Recruitment Partners",  img: "/work/uiux-3.webp" },
      { kind: "desktop", label: "For Institutions",      img: "/work/uiux-4.webp" },
      { kind: "desktop", label: "Services",              img: "/work/uiux-5.webp" },
      { kind: "desktop", label: "Events",                img: "/work/uiux-6.webp" },
      { kind: "desktop", label: "Blog",                  img: "/work/uiux-7.webp" },
      { kind: "desktop", label: "Sign Up & Login",       img: "/work/uiux-8.webp" },
    ],
    isReal: true,
    featured: true,
  },
];

/* Concepts removed for now — we lead with real work only.
   (Add real concept studies here later if you want a separate row.) */
export const CONCEPTS = [];

/* ⚑ EDIT ME — Replace with real client quotes once you have them.
   Keep only the ones that are genuine. Remove this whole array to
   hide the Testimonials section entirely. */
export const TESTIMONIALS = [
  { quote: "Add a real client quote here — what changed for their business after the project.", name: "Client Name", role: "Role, Company · City", project: "Website Design", av: IMAGES.av1 },
  { quote: "Add a second genuine quote here. Short, specific, and results-focused works best.", name: "Client Name", role: "Role, Company · City", project: "UI/UX Design", av: IMAGES.av2 },
];

export const WORK_FILTERS = ["All", "Live Websites", "UI/UX"];
