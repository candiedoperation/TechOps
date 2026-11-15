import React, { type ReactNode } from "react";
import DocItem from "@theme-original/DocItem";
import type DocItemType from "@theme/DocItem";
import type { WrapperProps } from "@docusaurus/types";

type Props = WrapperProps<typeof DocItemType>;

export default function DocItemWrapper(props: Props): ReactNode {
    return (
        <div className="w-full max-w-screen-2xl mx-auto">
            <DocItem {...props} />
        </div>
    );
}
