import "express";
import { GetGroupInfoResponse } from "../clients/AuthentikClient/models";

export interface ExpressRequestBindleExtension {
    teamInfo: GetGroupInfoResponse,
    requestedPermissions: string[]
}

declare module "express" {
    interface Request {
        bindle?: ExpressRequestBindleExtension
    }
}
