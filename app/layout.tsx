import type { Metadata, Viewport } from "next";
import { Inter, Newsreader } from "next/font/google";

import "./globals.css";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
  style: ["normal", "italic"],
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ?? "";

export const metadata: Metadata = {
  metadataBase: siteUrl ? new URL(siteUrl) : undefined,
  title: {
    default: "ProseLens — see what your chapter needs",
    template: "%s · ProseLens",
  },
  description:
    "Paste a machine-translated chapter and get it back as natural English, with every change shown beside the original so you can keep or undo it.",
  applicationName: "ProseLens",
  openGraph: {
    title: "ProseLens — see what your chapter needs",
    description:
      "Paste a machine-translated chapter and get it back as natural English, with every change shown beside the original so you can keep or undo it.",
    type: "website",
    siteName: "ProseLens",
  },
  twitter: {
    card: "summary_large_image",
    title: "ProseLens — see what your chapter needs",
    description:
      "Paste a machine-translated chapter and get it back as natural English, with every change shown beside the original.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0b0d14",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable}`}>
      <body className="min-h-dvh flex flex-col">
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
