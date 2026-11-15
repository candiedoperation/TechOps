import { prefixPath } from "@/lib/prefix";
import { a } from "framer-motion/client";
import Image from "next/image";
import React, { useId } from "react";

type PostProps = {
  imgSrc: string;
  caption: string;
  link: string;
  className?: string;
};

function Post({ imgSrc, caption, link, className = "" }: PostProps) {
  const captionId = useId();

  return (
    <a href={link} target="_blank" rel="noopener noreferrer">
      <figure
        className={`relative group w-full overflow-hidden cursor-pointer ${className}`}
        tabIndex={0}
        aria-labelledby={captionId}
      >
        {/* background color hover effect */}
        <div className="absolute inset-0 group-hover:bg-pink-100 transition-colors duration-500 z-0" />

        {/* image */}
        <Image
          width={750}
          height={750}
          src={prefixPath(imgSrc)}
          alt=""
          className="block"
        />

        {/* inner elements hover effect */}
        <div
          className="absolute inset-0 z-10 opacity-0 translate-y-4
               group-hover:opacity-100 group-hover:translate-y-0 group-focus-visible:opacity-100 group-focus-visible:translate-y-0
               transition-all duration-500 ease-out"
        >
          {/* top right photo icon */}
          <Image
            width={40}
            height={40}
            src={prefixPath("/icons/photoicon.svg")}
            alt=""
            aria-hidden="true"
            className="absolute top-2 right-2 w-10 h-10 sm:w-8 sm:h-8 md:w-9 md:h-9 lg:w-10 lg:h-10"
          />

          {/* like/comment icons + caption container */}
          <div className="w-full absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex flex-col gap-y-4 md:gap-y-10 items-center px-4">
            {/* like + comment icons */}
            <div className="flex items-center justify-center gap-x-2">
              <Image
                width={48}
                height={48}
                src={prefixPath("/icons/likeicon.svg")}
                alt="Like"
                aria-hidden="true"
                className="w-12 h-12 sm:w-10 sm:h-10 md:w-8 md:h-8 lg:w-10 lg:h-10 xl:w-10 xl:h-10 2xl:w-10 2xl:h-10"
              />
              <Image
                width={48}
                height={48}
                src={prefixPath("/icons/commenticon.svg")}
                alt="Comment"
                aria-hidden="true"
                className="w-12 h-12 sm:w-10 sm:h-10 md:w-8 md:h-8 lg:w-10 lg:h-10 xl:w-10 xl:h-10 2xl:w-10 2xl:h-10"
              />
            </div>

            {/* caption */}
            <div className="w-full flex justify-center items-center">
              <p
                id={captionId}
                className="text-center text-xl sm:text-base md:text-sm lg:text-base xl:text-lg 2xl:text-xl"
              >
                {caption}
              </p>
            </div>
          </div>
        </div>
      </figure>
    </a>
  );
}

export default Post;
