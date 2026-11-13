import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reins",
  description: "An AI agent that pays for your habits, within hard limits, and gets careful when money runs low.",
  // Added to an iPhone home screen, Reins opens full screen under its own name and icon
  appleWebApp: { capable: true, title: "Reins", statusBarStyle: "black" },
};

export const viewport: Viewport = { themeColor: "#1c1917" };

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("reins-theme")||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Pick the theme before the page paints, so there's no white flash in dark mode */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
