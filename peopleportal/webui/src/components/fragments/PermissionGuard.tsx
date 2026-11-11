/**
  People Portal UI
  Copyright (C) 2026  Atheesh Thirumalairajan

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "@/lib/utils";

type GuardedControlProps = {
    className?: string;
    disabled?: boolean;
    "aria-disabled"?: boolean;
    onClick?: React.MouseEventHandler;
    onCheckedChange?: (checked: boolean) => void;
};

export const NO_PERMISSION_MESSAGE = "You don't have permission to do this";

/**
 * Renders its control as-is when `allowed`. Otherwise the control is greyed
 * out rather than hidden: disabled, `aria-disabled`, with its handlers
 * dropped, and a tooltip explaining why. Pass `allowed={can("corp:...")}`
 * from useTeamPermissions, which is false while permissions are unknown.
 */
export const PermissionGuard = (props: {
    allowed: boolean;
    children: React.ReactElement<GuardedControlProps>;
    reason?: string;
}) => {
    if (props.allowed) return props.children;

    const reason = props.reason ?? NO_PERMISSION_MESSAGE;
    const control = React.cloneElement(props.children, {
        disabled: true,
        "aria-disabled": true,
        onClick: undefined,
        onCheckedChange: undefined,
        className: cn(props.children.props.className, "opacity-50"),
    });

    /* Disabled controls swallow pointer events, so the tooltip hangs off a wrapper */
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex cursor-not-allowed" title={reason}>
                    {control}
                </span>
            </TooltipTrigger>
            <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
    );
};
