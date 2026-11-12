export default function PullQuote({
  quote,
  cite,
  delay = '.12s',
}: {
  quote: string;
  cite: string;
  delay?: string;
}) {
  return (
    <div className="pull-quote fu" style={{ transitionDelay: delay }}>
      <p>{quote}</p>
      <cite>{cite}</cite>
    </div>
  );
}
