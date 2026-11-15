"use client";

import { useState } from "react";
import { Skeleton } from "./skeleton";

const VideoEmbed = ({ url }: { url: string }) => {
  const [loading, setLoading] = useState(true);

  return (
    <div className="relative w-full pb-[56.25%] h-0">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Skeleton className="w-full h-full" />
        </div>
      )}
      <iframe
        className="absolute top-0 left-0 w-full h-full"
        src={url}
        title="YouTube video player"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        onLoad={() => setLoading(false)}
      ></iframe>
    </div>
  );
};

export default VideoEmbed;
