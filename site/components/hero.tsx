import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { DOCS_URL } from "@/lib/site";

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="px-4 pt-12 pb-8">
      <div className="mx-auto max-w-xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-sm text-neutral-600">
          <span>Reviews · Descriptions · Q&A</span>
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </div>

        <h1 id="hero-heading" className="text-2xl leading-tight mb-4">
          Self-hosted AI pull request review platform
        </h1>

        <p className="text-neutral-600 mb-3">
          PR Agent is a full platform you deploy yourself: webhook intake, durable job queues, AI
          workers, and publish back to GitHub. An open-source alternative to hosted reviewers like
          CodeRabbit, Greptile, and Cursor Bugbot.
        </p>

        <p className="text-neutral-500 mb-6">
          Reviews, descriptions, and Q&A on pull requests. Your infrastructure, your credentials,
          your model provider.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-white hover:bg-blue-700 transition-colors"
          >
            Get started
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href="#examples"
            className="inline-flex items-center rounded-md border border-neutral-300 px-4 py-2.5 text-neutral-700 hover:bg-neutral-50 transition-colors"
          >
            See examples
          </Link>
        </div>

        <p className="mt-3 text-xs text-neutral-400">
          Or scroll to{" "}
          <a href="#usage" className="underline hover:text-neutral-600">
            usage
          </a>{" "}
          for Docker Compose quickstart.
        </p>
      </div>
    </section>
  );
}
