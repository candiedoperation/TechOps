import { notFound } from "next/navigation";
import Image from "next/image";
import Navbar from "@/components/layout/navbar";
import Link from "next/link";
import { ALL_PROJECTS } from "@/data/projects";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import VideoEmbed from "@/components/ui/video-embed";
import { prefixPath } from "@/lib/prefix";
import { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const project = ALL_PROJECTS.find((p) => p.slug === slug);

  if (!project) {
    return {
      title: "Project Not Found | ADC",
      description: "The requested project does not exist.",
    };
  }

  return {
    title: `${project.title} | ADC`,
    description:
      project.description || "Detailed information about the project",
  };
}

export async function generateStaticParams() {
  return ALL_PROJECTS.map((project) => ({
    slug: project.slug,
  }));
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = ALL_PROJECTS.find((p) => p.slug === slug);

  if (!project) {
    notFound();
  }

  // Only use actual members, do not fill with placeholders
  const members = project.members || [];

  return (
    <div className="pt-40 max-w-6xl mx-auto z-10 flex flex-col items-center">
      <Link href="/projects" className="self-start mb-6 hidden md:inline-block">
        <Button variant={"ghost"} className="rounded-xl">
          <ArrowLeft className="mr-1" />
          Back to Projects
        </Button>
      </Link>

      <div className="px-2 sm:px-4 flex flex-col items-center w-full">
        {/* Top rounded rectangle with logo and text split */}
        <div className="w-full border-2 border-blue-300 rounded-3xl p-10 mb-16 gap-6 md:gap-4 flex flex-col md:flex-row items-center bg-white shadow-lg">
          <div className="flex-[0.5] flex items-center justify-center h-full">
            {project.logo ? (
              <Image
                src={prefixPath(project.logo)}
                alt={project.title}
                width={400}
                height={400}
                className="object-contain max-h-20 max-w-full md:max-w-100"
                draggable={false}
              />
            ) : (
              <div className="w-28 h-28 rounded-full bg-blue-100 flex items-center justify-center">
                <span className="text-blue-400 text-4xl font-bold">?</span>
              </div>
            )}
          </div>
          <div className="flex-1 flex flex-col justify-center items-center text-center md:items-start md:text-start">
            <h1 className="text-4xl font-bold mb-2">{project.title}</h1>
            <p className="text-lg text-gray-600">{project.description}</p>
          </div>
        </div>
        {project.showcaseContent && (
          <div className="w-full flex flex-col items-center gap-2 mb-16">
            <div className="w-full max-w-5xl flex items-center justify-center relative">
              {project.showcaseContent.image ? (
                <Image
                  src={prefixPath(project.showcaseContent?.image)}
                  alt="Project Image"
                  width={900}
                  height={400}
                  className="object-contain w-full h-full max-h-[30rem] max-w-full"
                />
              ) : (
                <VideoEmbed url={project.showcaseContent.videoUrl || ""} />
              )}
            </div>
            <p className="text-gray-600 text-center">
              {project.showcaseContent?.description}
            </p>
          </div>
        )}
        <div className="relative flex items-center justify-center w-full my-8">
          <div className="absolute left-0 right-0 top-1/2 transform -translate-y-1/2 h-1 bg-blue-500 w-full z-0" />
          <h2 className="relative z-10 bg-white px-4 text-2xl sm:text-3xl font-bold text-subheader">
            Team Members
          </h2>
        </div>
        <div className="w-full flex flex-wrap justify-center gap-y-5 md:gap-x-25 gap-x-20 text-center">
          {members.map((member, idx) => (
            <div key={idx} className="flex flex-col items-center w-32">
              {member.photo ? (
                <div className="w-24 h-24 rounded-full overflow-hidden mb-2">
                  <Image
                    src={prefixPath(member.photo)}
                    alt={member.name}
                    width={120}
                    height={120}
                    className={`object-cover transform ${member.zoomPhotoIn ? "scale-150" : ""}`}
                    draggable={false}
                  />
                </div>
              ) : (
                <div className="w-24 h-24 rounded-full bg-gray-200 mb-2" />
              )}
              <div className="text-base font-medium text-gray-800">
                {member.name}
              </div>
              <div className="text-sm text-gray-500">{member.title}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
