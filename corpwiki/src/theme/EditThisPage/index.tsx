import React, { type ReactNode } from "react";
import Translate from "@docusaurus/Translate";
import Link from "@docusaurus/Link";
import IconEdit from "@theme/Icon/Edit";
import { Button } from "@/components/ui/button";

type Props = {
  editUrl: string;
};

export default function EditThisPageWrapper({ editUrl }: Props): ReactNode {
  return (
    <Button className="mt-2" variant="outline" size="sm" asChild>
      <Link to={editUrl}>
        <IconEdit />
        <Translate
          id="theme.common.editThisPage"
          description="The link label to edit the current page"
        >
          Edit this page
        </Translate>
      </Link>
    </Button>
  );
}
