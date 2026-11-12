import Icon from "./Icon.jsx";

import FadeImg from "./FadeImg.jsx";

export default function ProjectCard({ project, onNav }) {
  return (
    <div className="proj-card" onClick={() => onNav("detail", project.slug)}>
      <div className="proj-thumb">
        <FadeImg src={project.img} alt={project.title} className="proj-img" loading="lazy" />
        <div className="proj-overlay" />
        <div className="proj-chrome">
          <div className="cdot" style={{ background: "rgba(248,113,113,.7)" }} />
          <div className="cdot" style={{ background: "rgba(250,204,21,.7)" }} />
          <div className="cdot" style={{ background: "rgba(74,222,128,.7)" }} />
          <div className="chrome-u" />
        </div>
        <span className="proj-lbl">{project.label}</span>
      </div>
      <div className="proj-body">
        <span className="eyebrow-m">{project.category}</span>
        <h3 className="proj-title">{project.title}</h3>
        <p className="proj-sum">{project.description}</p>
        {project.outcome && (
          <p className="proj-out">
            <span className="proj-out-ico"><Icon name="chk" size={12} /></span>
            <span>{project.outcome}</span>
          </p>
        )}
        <div className="proj-foot">
          <span className="proj-ind">{project.industry}</span>
          <span className="proj-view">View project <Icon name="arrUR" size={14} /></span>
        </div>
      </div>
    </div>
  );
}
