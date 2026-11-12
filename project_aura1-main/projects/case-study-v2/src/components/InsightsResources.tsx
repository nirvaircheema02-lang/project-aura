type Resource = {
  img: string;
  badge?: 'Featured' | 'Latest';
  category?: string;
  date?: string;
  title: string;
  desc?: string;
};

/** 12 resource cards — verbatim copy + exact Figma images (downloaded to /public/figma). */
const RESOURCES: Resource[] = [
  { img: '/figma/gallery-01.jpg', badge: 'Featured', category: 'Technology', date: 'Jan 15, 2024', title: 'The Future of AI in Supply Chain Management', desc: 'Exploring how artificial intelligence is revolutionizing logistics operations and predictive analytics.' },
  { img: '/figma/gallery-02.jpg', badge: 'Featured', category: 'Sustainability', title: 'Sustainable Transportation Solutions' },
  { img: '/figma/gallery-03.jpg', badge: 'Latest', title: 'Industry 4.0 and Smart Manufacturing', desc: 'Integrating IoT and machine learning into production and distribution processes.' },
  { img: '/figma/gallery-04.jpg', badge: 'Featured', category: 'Security', title: 'Cybersecurity in Connected Supply Chains' },
  { img: '/figma/gallery-05.jpg', category: 'Strategy', date: 'Jan 8, 2024', title: 'Digital Transformation in Logistics' },
  { img: '/figma/gallery-06.jpg', title: 'Optimizing Last-Mile Delivery', desc: 'Innovative approaches to solving the most expensive part of the delivery chain.' },
  { img: '/figma/gallery-07.jpg', category: 'Insights', date: 'Jan 12, 2024', title: 'Building Resilient Supply Chains in 2024' },
  { img: '/figma/gallery-08.jpg', title: 'Blockchain for Supply Chain Transparency', desc: 'Exploring distributed ledger technology for end-to-end traceability and trust.' },
  { img: '/figma/gallery-09.jpg', category: 'Automation', date: 'Jan 10, 2024', title: 'Warehouse Automation: ROI and Implementation', desc: 'A comprehensive guide to implementing robotic systems and measuring their impact on operations.' },
  { img: '/figma/gallery-10.jpg', badge: 'Featured', title: 'Data-Driven Decision Making in Supply Chain', desc: 'Leveraging real-time analytics and business intelligence for competitive advantage.' },
  { img: '/figma/gallery-11.jpg', category: 'Global Trade', date: 'Jan 6, 2024', title: 'Navigating International Logistics Challenges', desc: 'Managing cross-border complexities and regulatory requirements in global supply chains.' },
  { img: '/figma/gallery-12.jpg', category: 'Leadership', date: 'Dec 28, 2023', title: 'Building High-Performance Logistics Teams', desc: 'Best practices for recruiting, training, and retaining top talent in the logistics industry.' },
];

/** "Industry Insights & Resources" dark gallery — shared across all templates. */
export default function InsightsResources() {
  return (
    <section className="insights">
      <div className="insights-in">
        <div className="insights-eyebrow fu">Related Resources</div>
        <h2 className="insights-h2 fu" style={{ transitionDelay: '.05s' }}>
          Industry Insights &amp; Resources
        </h2>
        <p className="insights-sub fu" style={{ transitionDelay: '.1s' }}>
          Expert perspectives and thought leadership on market intelligence, strategic consulting, and
          transformative business solutions
        </p>
        <div className="insights-grid">
          {RESOURCES.map((r, i) => (
            <article className="res-card fu" key={i}>
              <div className="res-imgwrap">
                <img className="res-img" src={r.img} alt="" />
                {r.badge && (
                  <span className={`res-badge ${r.badge === 'Featured' ? 'feat' : 'latest'}`}>{r.badge}</span>
                )}
              </div>
              <div className="res-body">
                {(r.category || r.date) && (
                  <div className="res-meta">
                    {r.category && <span className="res-cat">{r.category}</span>}
                    {r.date && <span className="res-date">{r.date}</span>}
                  </div>
                )}
                <h3 className="res-ttl">{r.title}</h3>
                {r.desc && <p className="res-desc">{r.desc}</p>}
              </div>
            </article>
          ))}
        </div>
        <div className="insights-foot">
          <button className="insights-btn">View All Resources <span aria-hidden>→</span></button>
        </div>
      </div>
    </section>
  );
}
