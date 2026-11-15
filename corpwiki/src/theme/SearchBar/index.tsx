import React, { useCallback, useRef, useState, useEffect, JSX } from "react";
import SearchBar from "@theme-original/SearchBar";
import type SearchBarType from "@theme/SearchBar";
import type { WrapperProps } from "@docusaurus/types";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Search } from "lucide-react";

type Props = WrapperProps<typeof SearchBarType>;

function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPod|iPad/.test(navigator.platform);
}

export default function SearchBarWrapper(props: Props): JSX.Element {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(isMacLike());
  }, []);

  const onOpen = useCallback(() => {
    const searchButton = document.querySelector(
      ".DocSearch-Button",
    ) as HTMLButtonElement;
    if (searchButton) {
      searchButton.click();
    }
  }, []);

  return (
    <>
      <div className="hidden">
        <SearchBar {...props} />
      </div>

      <div
        className="hidden items-center md:flex cursor-pointer"
        role="button"
        aria-label="Search"
        onClick={onOpen}
      >
        <div className="flex w-full max-w-xs flex-col gap-6">
          <InputGroup>
            <InputGroupInput
              placeholder="Search..."
              readOnly
              className="transition-colors cursor-pointer"
            />
            <InputGroupAddon>
              <Search className="h-4 w-4" />
            </InputGroupAddon>
            <InputGroupAddon align="inline-end" className="gap-1">
              <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
              <Kbd>K</Kbd>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </>
  );
}
