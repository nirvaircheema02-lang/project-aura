export type RelatedCard = {
  img: string;
  alt: string;
  type: string;
  title: string;
};

export default function RelatedSection({
  intro,
  cards,
}: {
  intro: string;
  cards: RelatedCard[];
}) {
  return (
    <section className="s-white">
      <div style={{ maxWidth: 'var(--max-w)', marginInline: 'auto', paddingInline: '2rem' }}>
        <div className="rel-hdr">
          <h2 className="h2 fu" style={{ marginBottom: 0 }}>
            Related case studies
          </h2>
          <a href="/case-studies">View all →</a>
        </div>
        <p className="body fu" style={{ transitionDelay: '.05s', maxWidth: '520px', marginBottom: 0 }}>
          {intro}
        </p>
        <div className="rel-grid fu" style={{ transitionDelay: '.1s' }}>
          {cards.map((c, i) => (
            <article className="rel-card" key={i}>
              <img className="rel-thumb" src={c.img} alt={c.alt} />
              <div className="rel-body">
                <div className="rel-type">{c.type}</div>
                <h3 className="rel-ttl">{c.title}</h3>
                <span className="rel-link">Read case study</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
