"use client";
import Image from "next/image";
import React from "react";
import { Button } from "../ui/button";
import { Menu } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetClose,
} from "@/components/ui/sheet";
import Link from "next/link";
import GradientText from "../ui/gradient-text";
import {
  applicationLink,
  internalLink,
  showApplicationLink,
  showInternalLink,
} from "@/data/links-and-feature-flags";
import { prefixPath } from "@/lib/prefix";
import { useActiveBanner } from "@/lib/useActiveBanner";

const getNavLinks = () => {
  const baseLinks = [
    { href: "/#about", label: "About", specialText: false },
    { href: "/#projects", label: "Projects" },
    { href: "/#sponsors", label: "Sponsors" },
    { href: "/#contact", label: "Contact Us" },
  ];
  const links = [...baseLinks];

  if (showApplicationLink) {
    links.push({
      href: applicationLink,
      label: "Apply Now",
      specialText: true,
    });
  }
  if (showInternalLink) {
    links.push({ href: internalLink, label: "Log In", specialText: false });
  }

  return links;
};
const navLinks = getNavLinks();

const Navbar = () => {
  const activeBanner = useActiveBanner();
  return (
    <nav
      className={`sticky top-4 md:top-6 w-[95%] max-w-6xl h-16 flex items-center justify-between px-6 py-3 rounded-full bg-white/60 backdrop-blur-md shadow-lg z-50 mx-auto ${activeBanner ? "mt-4 -mb-20" : "-mb-16"}`}
    >
      <Link
        href="/#home"
        className="flex items-center space-x-3"
        draggable={false}
      >
        <Image
          src={prefixPath("/common/adc-256.png")}
          alt="App Dev Club Logo"
          width={40}
          height={40}
          className="w-10 h-10"
          draggable={false}
        />
        <span className="md:text-lg lg:text-xl font-semibold text-gray-800">
          App Dev Club
        </span>
      </Link>

      <div className="hidden md:flex items-center space-x-8">
        {navLinks.map(({ href, label, specialText }) => (
          <NavbarLink key={href} href={href}>
            {specialText ? (
              <GradientText
                showBg={false}
                colors={["#0083ff", "#80cbc4", "#0083ff", "#0d47a1"]}
              >
                {label}
              </GradientText>
            ) : (
              label
            )}
          </NavbarLink>
        ))}
      </div>

      <Sheet>
        <SheetTrigger className="block md:hidden">
          <Button
            className="rounded-full p-1.5 hover:opacity-100"
            variant={"ghost"}
            asChild
          >
            <Menu className="w-10 h-10 text-gray-700 hover:text-blue-600" />
          </Button>
        </SheetTrigger>
        <SheetContent className="!w-[250px]">
          <SheetHeader>
            <SheetTitle className="flex flex-col text-2xl gap-5 mt-10">
              {navLinks.map(({ href, label, specialText }) => (
                <SheetClose asChild key={href}>
                  <NavbarLink key={href} href={href}>
                    {specialText ? (
                      <GradientText
                        showBg={false}
                        colors={["#0083ff", "#80cbc4", "#0083ff", "#0d47a1"]}
                      >
                        {label}
                      </GradientText>
                    ) : (
                      label
                    )}
                  </NavbarLink>
                </SheetClose>
              ))}
            </SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    </nav>
  );
};

type NavbarLinkProps = {
  href: string;
  children: React.ReactNode;
};

const NavbarLink: React.FC<NavbarLinkProps> = ({ href, children }) => (
  <Link
    href={href}
    draggable={false}
    target={href.startsWith("http") ? "_blank" : undefined}
    className="text-gray-700 hover:text-blue-600 transition-colors duration-200 font-semibold text-lg md:text-sm lg:text-base"
  >
    {children}
  </Link>
);

export default Navbar;
