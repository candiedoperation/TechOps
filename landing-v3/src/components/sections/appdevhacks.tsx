import { hackathonLink } from "@/data/links-and-feature-flags";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

export default function AppDevHacks() {
  return (
    <section
      aria-labelledby="appdevhacks-heading"
      className="w-full text-center relative z-0"
    >
      <h2
        id="appdevhacks-heading"
        className="pt-24 text-center text-3xl md:text-5xl font-bold text-subheader"
      >
        App Dev Hacks
      </h2>
      <div className="my-6">
        <p className="text-base md:text-xl text-gray-600 px-4">
          App Dev Hacks is a UMD student only hackathon where students team up
          to solve real problems for campus departments.
        </p>
        <p className="text-neutral-500 mt-3 px-4">
          Open to all students, not just those in ADC!
        </p>
      </div>

      <div className="flex justify-center">
        <Link
          href={hackathonLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-lg transition-transform hover:scale-[1.01] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#A855F7] shadow-[0_0_15px_rgba(168,85,247,0.6)]"
        >
          <span className="rounded-lg bg-white px-5 py-2 font-semibold text-black flex items-center gap-2">
            Explore App Dev Hacks
            <ArrowRight className="w-4 h-4" />
          </span>
        </Link>
      </div>
    </section>
  );
}
