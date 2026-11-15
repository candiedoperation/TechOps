import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import Navbar from "@/components/layout/navbar";
import Footer from "@/components/layout/footer";
import Banner from "@/components/layout/banner";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "App Dev Club",
  description:
    "501(c)(3) Non Profit helping foster the growth of Computer Science students through creating digital solutions for Fortune 500 Companies - EST. Sep 2023",
  keywords: [
    "University of Maryland",
    "App Dev Club",
    "Computer Science",
    "Student Organization",
    "Software Development",
    "Programming",
    "Hackathon",
    "Tech Club",
    "Fortune 500",
    "Digital Solutions",
    "Non Profit",
    "501(c)(3)",
  ],
  authors: [{ name: "App Dev Club" }],
  metadataBase: new URL("https://appdevclub.com"),
  openGraph: {
    title: "App Dev Club",
    description:
      "Fostering the growth of Computer Science students through creating digital solutions for Fortune 500 Companies - EST. Sep 2023",
    url: "https://appdevclub.com",
    siteName: "App Dev Club",
    images: [
      {
        url: "/og-image.webp",
        width: 1422,
        height: 800,
        alt: "App Dev Club",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "App Dev Club",
    description:
      "501(c)(3) Non Profit helping foster the growth of Computer Science students through creating digital solutions for Fortune 500 Companies - EST. Sep 2023",
    images: ["/og-image.webp"],
  },
  alternates: {
    canonical: "https://appdevclub.com",
  },
  robots: {
    index: true,
    follow: true,
    nocache: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${bricolage.variable} antialiased scroll-smooth min-h-screen overflow-x-clip`}
      >
        <Banner />
        <Navbar />
        {children}
        <Footer />
      </body>
    </html>
  );
}
