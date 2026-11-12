import { useState } from "react";
import Icon from "../components/Icon.jsx";
import Reveal from "../components/Reveal.jsx";

/* Two steps, both in place. The URL box is the whole of step one, so asking
   for an audit costs one field; the details only appear once someone has
   actually asked. Previously this handed off to the generic contact page and
   threw the URL away.

   Submits through the same EmailJS endpoint the contact form already uses —
   no new dependency, and the confirmation is true rather than decorative. */
const EMAILJS_SERVICE_ID = "service_lqjldzs";
const EMAILJS_TEMPLATE_ID = "template_6i3b8zb";
const EMAILJS_PUBLIC_KEY = "ALEUW-ef5rFwfHzQj";

export default function FreeAudit() {
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState("");
  const [form, setForm] = useState({ name: "", email: "", biz: "", goal: "" });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const startAudit = (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setStep(2);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: EMAILJS_SERVICE_ID,
          template_id: EMAILJS_TEMPLATE_ID,
          user_id: EMAILJS_PUBLIC_KEY,
          template_params: {
            name: form.name,
            biz: form.biz,
            email: form.email,
            phone: "",
            service: "Free website audit",
            message: `Website to audit: ${url}\n\nWhat to look at: ${form.goal || "Not specified"}`,
          },
        }),
      });
      if (res.ok) setStep(3);
      else setError("Something went wrong. Please try again, or message us on WhatsApp.");
    } catch {
      setError("Network error. Please try again, or message us on WhatsApp.");
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="sec sec-surf">
      <div className="wrap">
        <Reveal scale>
          <div className="audit-box">
            {/* Radar graphic — names only what the review actually covers. */}
            <div className="audit-radar">
              <div className="audit-ring r1" />
              <div className="audit-ring r2" />
              <div className="audit-ring r3" />
              <div className="audit-pill p-seo"><Icon name="trend" size={13} /> SEO</div>
              <div className="audit-pill p-growth"><Icon name="bar" size={13} /> Growth</div>
              <div className="audit-pill p-design"><Icon name="code" size={13} /> Design</div>
              <div className="audit-pill p-leads"><Icon name="flow" size={13} /> Leads</div>
              <div className="audit-core">
                <Icon name="srch" size={20} />
                <span>Free Audit</span>
              </div>
            </div>

            <div>
              <span className="eyebrow">Free review</span>

              {step === 3 ? (
                <>
                  <h2 className="audit-h">Your audit request is in.</h2>
                  <p className="audit-p">
                    We'll look through <strong className="audit-url">{url}</strong> and come back to you
                    with what we'd fix first.
                  </p>
                </>
              ) : (
                <>
                  <h2 className="audit-h">
                    Turn your website into a <span className="grad-text">growth engine</span>
                  </h2>
                  <p className="audit-p">
                    Get a free website and digital presence audit. We'll tell you exactly what to fix
                    first — design, SEO, lead flow, or automation.
                  </p>
                </>
              )}

              {step === 1 && (
                <form className="audit-form" onSubmit={startAudit}>
                  <input
                    className="inp"
                    type="url"
                    inputMode="url"
                    required
                    placeholder="https://yourwebsite.com"
                    aria-label="Your website address"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <button type="submit" className="btn-p">
                    Get Free Audit <Icon name="arr" size={15} />
                  </button>
                </form>
              )}

              {step === 2 && (
                <form className="audit-step2" onSubmit={submit}>
                  <p className="audit-for">
                    Auditing <strong className="audit-url">{url}</strong>
                    <button type="button" className="audit-change" onClick={() => setStep(1)}>Change</button>
                  </p>
                  <div className="audit-row">
                    <input className="inp" required placeholder="Your name" aria-label="Your name" value={form.name} onChange={set("name")} />
                    <input className="inp" required type="email" placeholder="Email" aria-label="Email" value={form.email} onChange={set("email")} />
                  </div>
                  <input className="inp" placeholder="Business name (optional)" aria-label="Business name" value={form.biz} onChange={set("biz")} />
                  <input className="inp" placeholder="Anything you'd like us to look at? (optional)" aria-label="What should we look at" value={form.goal} onChange={set("goal")} />
                  <button type="submit" className="btn-p" disabled={sending}>
                    {sending ? "Sending…" : <>Request my audit <Icon name="arr" size={15} /></>}
                  </button>
                  {error && <p className="audit-err">{error}</p>}
                </form>
              )}

              {step !== 3 && <p className="audit-note">No commitment. We'll only use your details to send the review.</p>}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
