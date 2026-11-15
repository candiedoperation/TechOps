"use client";
import { Banner } from "@/components/layout/banner";
import { banners } from "@/data/event-banner";
import { useEffect, useState } from "react";

/**
 * Returns the currently active banner (or null if none)
 */
export function useActiveBanner(): Banner | null {
  const [activeBanner, setActiveBanner] = useState<Banner | null>(null);

  useEffect(() => {
    const checkBanner = () => {
      const nowEST = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
      );

      const banner = banners.find(
        (b) => nowEST >= b.showBannerStartDate && nowEST <= b.showBannerEndDate,
      );
      setActiveBanner(banner || null);
    };

    checkBanner();
  }, []);

  return activeBanner;
}
