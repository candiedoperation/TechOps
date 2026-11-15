"use client";
import { cn } from "@/lib/utils";
import { useInView } from "react-intersection-observer";

interface FadeSlideInProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  direction?: "up" | "down" | "left" | "right";
}

function FadeSlideIn({
  children,
  delay = 0,
  className,
  direction = "up",
}: FadeSlideInProps) {
  const { ref, inView } = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  const getTransformClasses = () => {
    if (inView) return "opacity-100";

    // Always fade up on mobile, use direction on md and larger
    const mobileClasses = "opacity-0 translate-y-8";

    switch (direction) {
      case "up":
        return "opacity-0 translate-y-8";
      case "down":
        return `${mobileClasses} md:opacity-0 md:translate-y-0 md:-translate-y-8`;
      case "left":
        return `${mobileClasses} md:opacity-0 md:translate-y-0 md:translate-x-8`;
      case "right":
        return `${mobileClasses} md:opacity-0 md:translate-y-0 md:-translate-x-8`;
      default:
        return "opacity-0 translate-y-8";
    }
  };

  return (
    <div
      ref={ref}
      className={cn(
        "transition-all duration-500",
        getTransformClasses(),
        className,
      )}
      style={{
        transitionDelay: inView ? `${delay}ms` : "0ms",
      }}
    >
      {children}
    </div>
  );
}

export default FadeSlideIn;
