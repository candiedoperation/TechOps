import React from "react";
import Image from "next/image";
import { Button } from "../ui/button";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { FEATURED_PROJECTS } from "@/data/projects";
import BlueBorderContainer from "../ui/blue-border-container";
import { prefixPath } from "@/lib/prefix";
import FadeSlideIn from "../ui/fade-slide-in";

const Projects = () => {
  return (
    <section className="pt-20 scroll-mt-28 relative z-0" id="projects">
      <div className="w-full my-8 flex items-center justify-center relative">
        <div className="absolute left-0 right-0 top-1/2 transform -translate-y-1/2 h-1 bg-blue-500 w-full z-0" />
        <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold text-subheader bg-white px-6 text-center z-10">
          Featured Projects
        </h2>
      </div>
      <div className="w-full max-w-8xl mx-auto px-2 sm:px-4 flex flex-col gap-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 w-full items-stretch">
          {FEATURED_PROJECTS.map((project, idx) => {
            const isLastOddItem =
              idx === FEATURED_PROJECTS.length - 1 &&
              FEATURED_PROJECTS.length % 2 === 1;

            return (
              <FadeSlideIn
                key={project.title}
                delay={idx + 1 * 100}
                direction={idx === 0 ? "right" : idx === 2 ? "left" : "up"}
                className="h-full"
              >
                <BlueBorderContainer
                  className="flex flex-col items-center gap-3 p-6 h-full relative bg-white group overflow-hidden"
                  key={idx}
                  parentClassName={`${isLastOddItem ? "md:col-span-2 lg:col-span-1" : ""} h-full`}
                >
                  <div className="absolute inset-0 bg-gradient-to-b from-white to-blue-300/15 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                  <div className="flex justify-center items-center mb-2 z-10">
                    <Image
                      src={prefixPath(project.logo)}
                      alt={project?.logoAlt || "Project Logo"}
                      width={208}
                      height={96}
                      unoptimized={project.logo.endsWith(".svg")}
                      className="object-contain h-24 w-52"
                    />
                  </div>
                  <div className="text-lg font-semibold mb-1 text-gray-800 text-center z-10">
                    {project.title}
                  </div>
                  <div className="text-sm text-gray-600 mb-4 text-center flex-grow z-10">
                    {project.description}
                  </div>
                  <Link
                    href={`/projects/${project.slug}`}
                    className="w-full mt-auto z-10"
                  >
                    <Button
                      variant="roundedOutline"
                      className="w-full py-5 hover:bg-blue-100/75"
                    >
                      Read more <ArrowRight className="ml-1" />
                    </Button>
                  </Link>
                </BlueBorderContainer>
              </FadeSlideIn>
            );
          })}
        </div>
        <div className="flex flex-col items-center justify-center gap-y-10 m-6">
          <Link href="/projects">
            <Button
              size="lg"
              variant="default"
              className="text-lg font-semibold"
            >
              View All Projects
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
};

export default Projects;
