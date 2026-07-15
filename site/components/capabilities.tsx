import { CAPABILITIES } from "@/lib/content";

export function Capabilities() {
  return (
    <section
      id="capabilities"
      aria-labelledby="capabilities-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="capabilities-heading" className="text-xl mb-4">
          What your team gets back in GitHub
        </h2>

        <ul className="space-y-4">
          {CAPABILITIES.map((cap) => (
            <li key={cap.title} className="text-sm">
              <h3 className="font-medium text-neutral-800">{cap.title}</h3>
              <p className="text-neutral-500">{cap.trigger}</p>
              <p className="text-neutral-600 mt-0.5">{cap.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
