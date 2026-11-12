import { useEffect, useRef, useState } from "react";

/* An <img> that fades up once the file has actually decoded.

   Without this, a lazy image landing after its section has already revealed
   snaps in at full opacity — the reveal animates an empty box, then the
   picture appears a beat later. A cached image is already complete on mount,
   so it skips straight to shown and never flickers.

   Every other prop passes through, including onError: HomePage relies on it
   to hide an industry card whose art is missing. */
export default function FadeImg({ className = "", onLoad, ...rest }) {
  const ref = useRef(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true);
  }, []);

  const handleLoad = (e) => {
    setLoaded(true);
    onLoad?.(e);
  };

  return (
    <img
      ref={ref}
      className={`img-fade${loaded ? " is-loaded" : ""}${className ? ` ${className}` : ""}`}
      onLoad={handleLoad}
      {...rest}
    />
  );
}
