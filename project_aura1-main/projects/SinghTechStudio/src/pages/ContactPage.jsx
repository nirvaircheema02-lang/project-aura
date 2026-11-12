import { useState } from "react";
import Icon from "../components/Icon.jsx";
import Reveal from "../components/Reveal.jsx";
import { SERVICES } from "../data/services.js";
import { WA_URL } from "../data/constants.js";

// ⚠️ Apne EmailJS dashboard se ye 3 values yaha daalo
const EMAILJS_SERVICE_ID = "service_lqjldzs";
const EMAILJS_TEMPLATE_ID = "template_6i3b8zb";
const EMAILJS_PUBLIC_KEY = "ALEUW-ef5rFwfHzQj";

// ⚠️ Apna real email/phone yaha daalo
const CONTACT_EMAIL ="contact@singhtechstudio.com";
const CONTACT_PHONE = "+91 9540440101";

export default function ContactPage({ onNav }) {
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", biz: "", phone: "", email: "", service: "", msg: "" });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
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
            phone: form.phone,
            email: form.email,
            service: form.service,
            message: form.msg,
          },
        }),
      });

      if (res.ok) {
        setSubmitted(true);
      } else {
        setError("Something went wrong. Please try again or message us on WhatsApp.");
      }
    } catch (err) {
      setError("Network error. Please try again or message us on WhatsApp.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <section style={{ padding: "104px 0 0" }}>
        <div className="wrap">
          <Reveal className="sec-hd" head>
            <span className="eyebrow">Contact</span>
            <h1 style={{ marginTop: 14, lineHeight: 0.98, fontSize: "clamp(28px,4vw,60px)", fontWeight: 600, letterSpacing: "-0.03em" }}>
              Tell us about your project
            </h1>
            <p style={{ marginTop: 20, fontSize: "clamp(14px,1.6vw,17px)", color: "var(--muted)", lineHeight: 1.75 }}>
              Share a few details and we'll get back with ideas, options, and next steps. Free consultation, no pressure.
            </p>
          </Reveal>
        </div>
      </section>

      <section style={{ padding: "40px 0 80px" }}>
        <div className="wrap">
          <Reveal>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                borderRadius: "var(--radius-xl)",
                background: "var(--brand-soft)",
                overflow: "hidden",
              }}
            >
              {/* Info panel */}
              <div style={{ flex: "1 1 320px", padding: "48px 40px" }}>
                <span className="eyebrow">We're here to help you</span>
                <h2 style={{ marginTop: 16, fontSize: "clamp(24px,2.6vw,34px)", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.15 }}>
                  Discuss Your Project Needs
                </h2>
                <p style={{ marginTop: 16, fontSize: 14, color: "var(--muted)", lineHeight: 1.7, maxWidth: 320 }}>
                  Are you looking for top-quality web solutions tailored to your needs? Reach out to us.
                </p>

                <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: "var(--radius-md)", background: "var(--brand)", color: "#fff", flexShrink: 0 }}>
                      <Icon name="mail" size={18} />
                    </div>
                    <div>
                      <p style={{ fontSize: 13, color: "var(--muted)" }}>E-mail</p>
                      <a href={`mailto:${CONTACT_EMAIL}`} style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", textDecoration: "none" }}>
                        {CONTACT_EMAIL}
                      </a>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: "var(--radius-md)", background: "var(--brand)", color: "#fff", flexShrink: 0 }}>
                      <Icon name="clk" size={18} />
                    </div>
                    <div>
                      <p style={{ fontSize: 13, color: "var(--muted)" }}>Phone number</p>
                      <a href={`tel:${CONTACT_PHONE.replace(/\s/g, "")}`} style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", textDecoration: "none" }}>
                        {CONTACT_PHONE}
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Form */}
              <div style={{ flex: "1 1 380px", padding: 24, display: "flex" }}>
                <div
                  className="contact-form"
                  style={{
                    flex: 1,
                    background: "var(--bg, #fff)",
                    borderRadius: "var(--radius-xl)",
                    boxShadow: "0 20px 50px -20px rgba(0,0,0,0.15)",
                    padding: 32,
                  }}
                >
                  {submitted ? (
                    <div style={{ display: "grid", placeItems: "center", padding: "48px 16px", textAlign: "center" }}>
                      <div style={{ display: "grid", placeItems: "center", width: 52, height: 52, borderRadius: "50%", background: "var(--brand-soft)", color: "var(--brand)" }}>
                        <Icon name="chk" size={22} />
                      </div>
                      <h2 style={{ marginTop: 16, fontSize: 20, fontWeight: 600 }}>Thanks — we got your message</h2>
                      <p style={{ marginTop: 8, maxWidth: 380, fontSize: 14, color: "var(--muted)" }}>
                        We usually respond within 24 hours. For something urgent, message us on WhatsApp.
                      </p>
                      <a href={WA_URL} target="_blank" rel="noreferrer"
                        style={{ marginTop: 20, display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: "var(--radius-md)", background: "#25D366", color: "#fff", fontSize: 14, fontWeight: 500, textDecoration: "none" }}>
                        <Icon name="msg" size={16} /> Message on WhatsApp
                      </a>
                    </div>
                  ) : (
                    <form onSubmit={handleSubmit} className="stagger" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                      <div className="form-row">
                        <div className="field"><label>Name <span className="req">*</span><input required type="text" className="inp" placeholder="Your full name" value={form.name} onChange={set("name")} /></label></div>
                        <div className="field"><label>Business name<input type="text" className="inp" placeholder="Company / brand" value={form.biz} onChange={set("biz")} /></label></div>
                      </div>
                      <div className="form-row">
                        <div className="field"><label>Phone <span className="req">*</span><input required type="tel" className="inp" placeholder="+91 ..." value={form.phone} onChange={set("phone")} /></label></div>
                        <div className="field"><label>Email <span className="req">*</span><input required type="email" className="inp" placeholder="you@email.com" value={form.email} onChange={set("email")} /></label></div>
                      </div>
                      <div className="field" style={{ gridColumn: "1 / -1" }}>
                        <label>Service required <span className="req">*</span>
                          <select required className="inp" value={form.service} onChange={set("service")}>
                            <option value="" disabled>Select a service</option>
                            {SERVICES.map(s => <option key={s.slug} value={s.title}>{s.title}</option>)}
                            <option value="other">Something else</option>
                          </select>
                        </label>
                      </div>
                      <div className="field">
                        <label>Brief requirement
                          <textarea rows={4} className="inp" placeholder="A few lines about your business and what you need." value={form.msg} onChange={set("msg")} />
                        </label>
                      </div>
                      <div>
                        <button type="submit" className="btn-solid" disabled={sending} style={{ height: 48, padding: "0 28px", borderRadius: "var(--radius-sm)", opacity: sending ? 0.7 : 1 }}>
                          {sending ? "Sending..." : "Send message"}
                        </button>
                        {error && (
                          <p style={{ marginTop: 12, fontSize: 13, color: "#e5484d" }}>{error}</p>
                        )}
                        <p style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
                          No spam. We'll only use your details to respond to your inquiry.
                        </p>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}