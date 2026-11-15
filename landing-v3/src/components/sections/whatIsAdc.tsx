import React from "react";
import BlueBorderContainer from "../ui/blue-border-container";
import FadeSlideIn from "../ui/fade-slide-in";

const InfoCard = ({
  title,
  description,
  delay,
}: {
  title: string;
  description: string;
  delay?: number;
}) => {
  return (
    <FadeSlideIn delay={delay}>
      <BlueBorderContainer className="group relative flex flex-col items-center sm:gap-5 p-5 lg:p-10 h-44 md:h-80 w-full bg-white overflow-hidden hover:shadow-lg transition-shadow duration-300">
        <div className="absolute inset-0 bg-gradient-to-b from-white to-blue-300/15 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
        <div className="relative  text-center z-10">
          <h3 className="text-2xl font-bold uppercase">{title}</h3>
          <p className="mt-5 text-base md:text-lg">{description}</p>
        </div>
      </BlueBorderContainer>
    </FadeSlideIn>
  );
};

const WhatIsAdc = () => {
  return (
    <section className="pt-15 scroll-mt-28 relative z-0" id="about">
      <div className="relative flex items-center justify-center w-full my-8">
        <div className="absolute left-0 right-0 top-1/2 transform -translate-y-1/2 h-1 bg-blue-500 w-full z-0" />
        <h2 className="relative z-10 bg-white px-2 md:px-6 text-3xl md:text-5xl lg:text-6xl font-bold text-subheader">
          What is App Dev Club?
        </h2>
      </div>

      <div className="max-w-6xl mx-auto px-4 text-base md:text-lg text-center flex flex-col gap-12">
        <FadeSlideIn>
          <p className="text-justify md:text-center text-base md:text-xl text-gray-600 px-4">
            App Dev Club is a registered 501(c)(3) nonprofit organization
            dedicated to bridging the gap between academic theory and real-world
            engineering. We partner with industry mentors and organizations to
            provide undergraduate students with hands-on software development
            experience, experiential learning tracks, and technical mentorship
            over the course of the semester.
          </p>
        </FadeSlideIn>

        <div className="flex justify-around flex-col md:flex-row gap-5 lg:gap-10 xl:gap-20">
          <InfoCard
            title="Bootcamp"
            description="Develop your technical skills, work with your mentor, and transition into project teams."
            delay={50}
          />
          <InfoCard
            title="Projects"
            description="Gain valuable internship experience by working on a project with industry experts."
            delay={100}
          />
          <InfoCard
            title="Startups"
            description="Work with startups to develop an innovative new product that solves real problems."
            delay={150}
          />
        </div>
      </div>
    </section>
  );
};

export default WhatIsAdc;
