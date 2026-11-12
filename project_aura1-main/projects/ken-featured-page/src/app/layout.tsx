import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ken Research — Media Citations",
  description:
    "Where leading newsrooms cite Ken Research. Explore how journalists, publications, and business platforms use Ken Research data, forecasts, and market intelligence to frame stories across industries and geographies.",
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
