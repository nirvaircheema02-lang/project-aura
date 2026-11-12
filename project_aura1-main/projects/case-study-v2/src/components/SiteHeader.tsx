const KenMark = () => (
  <div className="nav-mark">
    <svg viewBox="0 0 18 18">
      <path d="M3 2h2.5v6l5-6H14l-5.5 6.5L14.5 16H11l-5.5-7V16H3z" />
    </svg>
  </div>
);

const Chev = () => <span className="hd-chev">▾</span>;

/**
 * Global Ken Research site header, synced from Figma.
 * - variant "abc": utility bar (Procurement / Expert Panel / Company · Sign in / Sign up)
 *   + main nav (Reports / Industries / Surveys / Consulting / Insights) + search + Book discovery call.
 * - variant "d": "Latest reports" bar + Log in / Services / Industries / Resources / Search / Schedule a Demo.
 */
export default function SiteHeader({ variant = 'abc' }: { variant?: 'abc' | 'd' }) {
  if (variant === 'd') {
    return (
      <header className="site-hd">
        <div className="hd-util">
          <div className="hd-util-in">
            <div className="hd-util-grp">
              <span>Latest reports:</span>
              <a href="#">India Makhana Market Outlook to 2030</a>
            </div>
            <div className="hd-util-grp">
              <a href="#">Log in</a>
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
              <a href="#">Services <Chev /></a>
              <a href="#">Industries <Chev /></a>
              <a href="#">Resources <Chev /></a>
            </nav>
            <div className="hd-spacer" />
            <div className="hd-search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <span>Search</span>
            </div>
            <button className="hd-book">Schedule a Demo</button>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="site-hd">
      <div className="hd-util">
        <div className="hd-util-in">
          <div className="hd-util-grp">
            <a href="#">Procurement</a>
            <a href="#">Expert Panel</a>
            <a href="#">Company <Chev /></a>
          </div>
          <div className="hd-util-grp">
            <a href="#">Sign in</a>
            <a href="#" className="hd-signup">Sign up</a>
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
            <a href="#">Reports <Chev /></a>
            <a href="#">Industries <Chev /></a>
            <a href="#">Surveys <Chev /></a>
            <a href="#">Consulting <Chev /></a>
            <a href="#">Insights <Chev /></a>
          </nav>
          <div className="hd-spacer" />
          <div className="hd-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <span>Search</span>
          </div>
          <button className="hd-book">Book discovery call</button>
        </div>
      </div>
    </header>
  );
}
