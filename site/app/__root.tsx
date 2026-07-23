import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { PRODUCT_NAME, SEO_DESCRIPTION, SEO_KEYWORDS, SEO_TITLE } from "@/lib/seo";
import { SITE_ORIGIN } from "@/lib/site";
import appCss from "./globals.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: SEO_TITLE },
      {
        name: "description",
        content: SEO_DESCRIPTION,
      },
      {
        name: "keywords",
        content: SEO_KEYWORDS.join(", "),
      },
      {
        name: "application-name",
        content: PRODUCT_NAME,
      },
      {
        name: "robots",
        content: "index, follow, max-video-preview:-1, max-image-preview:large, max-snippet:-1",
      },
      {
        property: "og:title",
        content: SEO_TITLE,
      },
      {
        property: "og:description",
        content: SEO_DESCRIPTION,
      },
      {
        property: "og:type",
        content: "website",
      },
      {
        property: "og:url",
        content: `${SITE_ORIGIN}/`,
      },
      {
        property: "og:site_name",
        content: PRODUCT_NAME,
      },
      {
        property: "og:locale",
        content: "en_US",
      },
      {
        property: "og:image",
        content: `${SITE_ORIGIN}/og-image.png`,
      },
      {
        property: "og:image:width",
        content: "1200",
      },
      {
        property: "og:image:height",
        content: "630",
      },
      {
        property: "og:image:alt",
        content: `${PRODUCT_NAME} - AI PR reviews on your own servers`,
      },
      {
        name: "twitter:card",
        content: "summary_large_image",
      },
      {
        name: "twitter:title",
        content: SEO_TITLE,
      },
      {
        name: "twitter:description",
        content: SEO_DESCRIPTION,
      },
      {
        name: "twitter:image",
        content: `${SITE_ORIGIN}/og-image.png`,
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "canonical",
        href: `${SITE_ORIGIN}/`,
      },
      {
        rel: "icon",
        href: "/favicon.png",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
    ],
  }),
  component: RootLayout,
});

function RootLayout() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };",
          }}
        />
        <script defer src="/_vercel/insights/script.js" />
      </head>
      <body className="bg-navy text-ink min-h-screen overflow-x-hidden">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
