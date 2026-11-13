import type { MetadataRoute } from "next";

// Lets people add Reins to their phone's home screen and open it like an app (no browser bars)
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Reins",
    short_name: "Reins",
    description: "An AI agent that pays for your habits, within hard limits, and gets careful when money runs low.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f0e0d",
    theme_color: "#1c1917",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
