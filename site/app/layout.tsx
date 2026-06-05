import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { PRODUCT_NAME, SEO_DESCRIPTION, SEO_KEYWORDS, SEO_TITLE } from "@/lib/seo";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: SEO_TITLE,
    template: `%s | ${PRODUCT_NAME}`,
  },
  description: SEO_DESCRIPTION,
  keywords: SEO_KEYWORDS,
  applicationName: PRODUCT_NAME,
  category: "technology",
  creator: "prathamdby",
  publisher: "prathamdby",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    type: "website",
    siteName: PRODUCT_NAME,
    locale: "en_US",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: `${PRODUCT_NAME} - Self-hosted AI pull request review platform`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: ["/og-image.png"],
  },
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-800 min-h-screen">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
