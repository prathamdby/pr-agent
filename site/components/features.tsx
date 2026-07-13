const features = [
  {
    title: "Works where your team already is",
    detail:
      "PR Agent watches pull requests and comments, then picks up review work without extra tabs or tools.",
  },
  {
    title: "Runs on infrastructure you control",
    detail:
      "Deploy on your servers. Your GitHub credentials and AI keys stay in your environment, not a vendor's.",
  },
  {
    title: "Keeps results in the pull request",
    detail: "Reviews, descriptions, and answers show up in the PR thread your team already reads.",
  },
  {
    title: "Simple commands from PR comments",
    detail:
      "Type /review, /describe, /ask, /triage, or /help in a comment when you want a specific result.",
  },
  {
    title: "Honest limits on large changes",
    detail:
      "Very large pull requests may get a partial review. When that happens, PR Agent tells you what it could not cover.",
  },
];

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="features-heading" className="text-xl mb-4">
          Stop burning reviewer time on repeat checks
        </h2>

        <ul className="space-y-4">
          {features.map((feature) => (
            <li key={feature.title} className="text-sm">
              <h3 className="font-medium text-neutral-800">{feature.title}</h3>
              <p className="text-neutral-600 mt-0.5">{feature.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
