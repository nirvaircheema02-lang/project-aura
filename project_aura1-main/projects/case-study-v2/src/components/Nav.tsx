const KenMark = () => (
  <div className="nav-mark">
    <svg viewBox="0 0 18 18">
      <path d="M3 2h2.5v6l5-6H14l-5.5 6.5L14.5 16H11l-5.5-7V16H3z" />
    </svg>
  </div>
);

export default function Nav({ crumb }: { crumb: string }) {
  return (
    <nav className="nav">
      <div className="nav-in">
        <div className="nav-logo">
          <KenMark />
          <span className="nav-name">Ken Research</span>
        </div>
        <nav className="nav-crumb">
          <a href="/insights">Insights</a>
          <span>/</span>
          <a href="/case-studies">Case studies</a>
          <span>/</span>
          <span style={{ color: 'rgba(255,255,255,.65)' }}>{crumb}</span>
        </nav>
        <button className="nav-cta">Start a similar project</button>
      </div>
    </nav>
  );
}
