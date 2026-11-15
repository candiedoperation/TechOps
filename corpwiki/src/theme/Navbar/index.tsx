import React, { type ReactNode } from "react";
import type { WrapperProps } from "@docusaurus/types";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import { ThemeConfig } from "@docusaurus/preset-classic";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { Button } from "@/components/ui/button";
import NavbarType from "@theme/Navbar";
import SearchBar from "@theme/SearchBar";

type Props = WrapperProps<typeof NavbarType>;

// Docusaurus internals (useTOCHighlight) expect a .navbar element to exist for scroll offset calculations.
// We render a hidden one to prevent crashes while the visible navbar is handled by the new layout.
export default function NavbarWrapper(props: Props): ReactNode {
    return <div className="navbar hidden" style={{ display: "none" }} />;
}
/*
export default function NavbarWrapper(props: Props): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  // ... (original code preserved in comment if needed, or just deleted)
  return (
      <header className="...">
        // ...
      </header>
  );
}
*/
