const KenMark = () => (
  <div className="nav-mark">
    <svg viewBox="0 0 18 18">
      <path d="M3 2h2.5v6l5-6H14l-5.5 6.5L14.5 16H11l-5.5-7V16H3z" />
    </svg>
  </div>
);

const Chev = () => <span className="hd-chev">▾</span>;

/**
 * Global Ken Research site header (ported from case-study-v2, self-contained).
 * Utility bar (Procurement / Expert Panel / Company · Sign in / Sign up) + main
 * nav (Reports / Industries / Surveys / Consulting / Insights) + search + CTA.
 */
export default function SiteHeader() {
  return (
    <header className="site-hd">
      <div className="hd-util">
        <div className="hd-util-in">
          <div className="hd-util-grp">
            <a href="#">Procurement</a>
            <a href="#">Expert Panel</a>
            <a href="#">
              Company <Chev />
            </a>
          </div>
          <div className="hd-util-grp">
            <a href="#">Sign in</a>
            <a href="#" className="hd-signup">
              Sign up
            </a>
          </div>
        </div>
      </div>
      <div className="hd-nav">
        <div className="hd-nav-in">
          <div className="hd-logo">
            <KenMark />
            <span className="hd-logo-tx">Ken Research</span>
          </div>
          <nav className="hd-menu">
            <a href="#">
              Reports <Chev />
            </a>
            <a href="#">
              Industries <Chev />
            </a>
            <a href="#">
              Surveys <Chev />
            </a>
            <a href="#">
              Consulting <Chev />
            </a>
            <a href="#">
              Insights <Chev />
            </a>
          </nav>
          <div className="hd-spacer" />
          <div className="hd-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>Search</span>
          </div>
          <button className="hd-book">Book discovery call</button>
          <button className="hd-burger" aria-label="Open menu">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
