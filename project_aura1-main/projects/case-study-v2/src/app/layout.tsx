import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ken Research — Case Study Templates",
  description:
    "Case study templates (V2) — Stat-led, Narrative, Visual, and Quote-led layouts for Ken Research engagements.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
