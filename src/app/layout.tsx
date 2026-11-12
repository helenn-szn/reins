import type { Metadata } from "next";
import "@fontsource/young-serif/400.css";
import "@fontsource-variable/instrument-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reins",
  description: "An AI agent that pays for your habits, within hard limits, and gets careful when money runs low.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
