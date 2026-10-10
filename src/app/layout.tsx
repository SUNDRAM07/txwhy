import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://txwhy.vercel.app"),
  title: "TxWhy - fix failed Solana transactions",
  description: "Paste a failed Solana transaction. Get the exact cause and a rebuilt transaction, simulated to prove it passes. API for agents and bots.",
  openGraph: {
    title: "TxWhy: failed Solana transaction in, working transaction out",
    description: "The exact cause, a rebuilt transaction that already passed simulation, and a proof you can check offline. Free for people, metered for agents.",
    url: "https://txwhy.vercel.app",
    siteName: "TxWhy",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "TxWhy: failed Solana transaction in, working transaction out" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "TxWhy: failed Solana transaction in, working transaction out",
    description: "The exact cause, a rebuilt transaction that already passed simulation, and a proof you can check offline.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
