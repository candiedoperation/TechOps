import React from "react";
import Post from "./post";
import Link from "next/link";
import FadeSlideIn from "../ui/fade-slide-in";

const Instagram = () => {
  return (
    <section
      id="contact"
      className="w-full flex flex-col items-center justify-center pt-32 scroll-mt-32 relative z-0"
    >
      {/* title */}
      <FadeSlideIn className="max-w-[85%]">
        <h1 className="font-bold leading-[1.1] text-5xl sm:text-6xl md:text-7xl mb-8 text-center bg-gradient-to-r from-[#515BD4] via-[#8134AF] to-[#DD2A7B] bg-clip-text text-transparent">
          Follow Us on Instagram!
        </h1>
      </FadeSlideIn>

      {/* instagram profile gradient button link */}
      <FadeSlideIn
        delay={50}
        className="flex items-center justify-center mb-10"
      >
        <Link
          href="https://www.instagram.com/app_dev_club/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Visit our Instagram profile"
          className="flex  items-center justify-center group rounded-lg w-34  hover:scale-[1.01] transition-transform to-[#DD2A7B] shadow-[0_0_15px_rgba(129,52,175,0.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#8134AF] focus-visible:ring-offset-white"
        >
          <span
            className="flex rounded-lg h-full w-full items-center justify-center py-3
               bg-white text-black 
               transition-all duration-300
               group-hover:bg-transparent group-hover:text-[#DD2A7B] font-semibold"
          >
            @app_dev_club
          </span>
        </Link>
      </FadeSlideIn>

      {/* instagram posts; surrounding divs act as top + bottom borders */}
      <div>
        <div className="h-1 bg-gradient-to-r from-[#DD2A7B] via-[#8134AF] to-[#515BD4]"></div>
        <div className="flex w-full sm:gap-x-1 bg-gradient-to-r from-[#DD2A7B] via-[#8134AF] to-[#515BD4]">
          <Post
            imgSrc="/post1.png"
            caption="Welcome to AppDev intern week! This week you'll see some of our members show us a day in their lives as interns! Be sure to tune in and ask questions! ☀️ 💻 💼"
            link="https://www.instagram.com/p/DM6eKHNueML/"
          />
          <Post
            imgSrc="/post2.png"
            caption="An emotional ending to the semester as our final event 
            marked not only the end of the school year but also the departure of our senior and founding class."
            className="hidden sm:block"
            link="https://www.instagram.com/p/DKH0uJduEU-/?img_index=1"
          />
          <Post
            imgSrc="/post3.png"
            caption="Bridging together our Bootcamp! (the bond between skewers and Elmer’s may not last… 
            but at least the bond between bootcamp members does 😉)"
            className="hidden sm:block"
            link="https://www.instagram.com/p/DHOmMMoucnY/?img_index=1"
          />
        </div>
        <div className="h-1 bg-gradient-to-r from-[#DD2A7B] via-[#8134AF] to-[#515BD4] hidden sm:block"></div>
        <div className="h-1 bg-gradient-to-r from-[#515BD4] via-[#8134AF] to-[#DD2A7B] block sm:hidden"></div>
      </div>
    </section>
  );
};

export default Instagram;
