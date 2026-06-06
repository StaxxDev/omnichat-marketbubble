import "./globals.css";

export const metadata = {
  title: "OmniChat Cloud — unified Twitch + X + Kick feed",
  description:
    "Multi-tenant SaaS that aggregates Twitch, X and Kick chat into one labeled real-time feed.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
