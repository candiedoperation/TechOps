import { Metadata } from "next";
import React, { ReactNode } from "react";

interface ProjectLayoutProps {
  readonly children: ReactNode;
}

export default function ProjectLayout({ children }: ProjectLayoutProps) {
  return (
    <main className="relative w-full bg-white pb-16">
      {/* Blue bar behind the navbar */}
      <div className="absolute top-0 left-0 w-full h-26 md:h-30 bg-gradient-blue z-0" />
      {children}
    </main>
  );
}
