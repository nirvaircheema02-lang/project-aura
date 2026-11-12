import { Fragment } from "react";

/* Splits a heading into word-masks so each word rises up + settles from the
   accent color to the text color, staggered. Drives off a parent `.show`
   (use inside a <Reveal head> wrapper, on an element with class `split-h`). */
export default function SplitWords({ text, start = 90, step = 45 }) {
  const words = String(text).split(" ");
  return (
    <>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="sw-w">
            <span className="sw-i" style={{ transitionDelay: `${start + i * step}ms` }}>{w}</span>
          </span>
          {i < words.length - 1 ? " " : ""}
        </Fragment>
      ))}
    </>
  );
}
