export default function CTA({
  headline,
  primary,
  secondary,
}: {
  headline: string;
  primary: string;
  secondary: string;
}) {
  return (
    <section className="cta-sec">
      <div className="cta-inn">
        <div>
          <div className="cta-lbl">Start a project</div>
          <h2 className="cta-hdl">{headline}</h2>
        </div>
        <div className="cta-acts">
          <button className="btn-p">{primary}</button>
          <button className="btn-g">{secondary}</button>
        </div>
      </div>
    </section>
  );
}
