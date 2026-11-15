import { cn } from "@/lib/utils";
import React from "react";

const BlueBorderContainer = ({
  children,
  className,
  parentClassName,
}: React.PropsWithChildren<{
  className?: string;
  parentClassName?: string;
}>) => {
  return (
    <div
      className={cn(
        "bg-gradient-to-br from-[#00B5FF] to-[#0083FF] p-[4px] rounded-4xl shadow-lg hover:scale-[1.01] transition-transform",
        parentClassName,
      )}
    >
      <div className={cn("bg-white rounded-[calc(2rem-4px)]", className)}>
        {children}
      </div>
    </div>
  );
};

export default BlueBorderContainer;
