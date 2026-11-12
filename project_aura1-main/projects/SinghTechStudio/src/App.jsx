import { useState, useEffect } from "react";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import WhatsAppFloat from "./components/WhatsAppFloat.jsx";
import HomePage from "./pages/HomePage.jsx";
import ServicesPage from "./pages/ServicesPage.jsx";
import WorkPage from "./pages/WorkPage.jsx";
import ProjectDetailPage from "./pages/ProjectDetailPage.jsx";
import AboutPage from "./pages/AboutPage.jsx";
import ContactPage from "./pages/ContactPage.jsx";

/* Pages that use a dark hero (transparent header) */
const DARK_HERO_PAGES = ["home", "work"];

const PATH_TO_PAGE = {
  "/": "home",
  "/services": "services",
  "/work": "work",
  "/about": "about",
  "/contact": "contact",
};

function getRouteFromUrl() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean);

  if (segments[0] === "project" && segments[1]) {
    return { page: "detail", slug: decodeURIComponent(segments.slice(1).join("/")) };
  }

  const page = PATH_TO_PAGE[path] || PATH_TO_PAGE[`/${segments[0] || ""}`] || "home";
  return { page, slug: null };
}

const SITE_URL = "https://singhtechstudio.com";

function updateCanonical(page, slug) {
  let path = "/";
  if (page === "detail" && slug) {
    path = `/project/${encodeURIComponent(slug)}`;
  } else if (page && PATH_TO_PAGE[`/${page}`]) {
    path = `/${page}`;
  }

  let link = document.querySelector("link[rel='canonical']");
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", `${SITE_URL}${path}`);
}

function ScrollProgress() {
  const [prog, setProg] = useState(0);
  useEffect(() => {
    const fn = () => {
      const el  = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      setProg(max > 0 ? window.scrollY / max : 0);
    };
    window.addEventListener("scroll", fn, { passive: true });
    return () => window.removeEventListener("scroll", fn);
  }, []);
  return (
    <div className="scroll-prog" style={{ transform: `scaleX(${prog})` }} />
  );
}

export default function App() {
  const [route, setRoute] = useState(() => getRouteFromUrl());

  useEffect(() => {
    const handlePopState = () => setRoute(getRouteFromUrl());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    updateCanonical(route.page, route.slug);
  }, [route.page, route.slug]);

  const navigate = (page, slug = null) => {
    let nextPath = "/";

    if (page === "detail" && slug) {
      nextPath = `/project/${encodeURIComponent(slug)}`;
    } else if (page && PATH_TO_PAGE[`/${page}`]) {
      nextPath = `/${page}`;
    }

    const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
    if (currentPath !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }

    setRoute({ page, slug });
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const isHero = DARK_HERO_PAGES.includes(route.page);

  const renderPage = () => {
    switch (route.page) {
      case "home":    return <HomePage        onNav={navigate} />;
      case "services":return <ServicesPage    onNav={navigate} />;
      case "work":    return <WorkPage        onNav={navigate} />;
      case "detail":  return <ProjectDetailPage slug={route.slug} onNav={navigate} />;
      case "about":   return <AboutPage       onNav={navigate} />;
      case "contact": return <ContactPage     onNav={navigate} />;
      default:        return <HomePage        onNav={navigate} />;
    }
  };

  return (
    <div className="page">
      <ScrollProgress />
      <Header page={route.page} onNav={navigate} transparent={isHero} />
      <main className="page-main">
        {/* Keyed so a route change remounts and replays the entrance. */}
        <div key={`${route.page}:${route.slug || ""}`} className="page-swap">{renderPage()}</div>
      </main>
      {/* Reserves exactly enough scroll to uncover the fixed footer beneath. */}
      <div className="ft-space" aria-hidden="true" />
      <Footer onNav={navigate} />
      <WhatsAppFloat />
    </div>
  );
}