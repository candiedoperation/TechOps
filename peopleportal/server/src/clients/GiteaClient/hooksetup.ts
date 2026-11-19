import axios from "axios";
import log from "loglevel";
import { getGiteaWebhookAuthorizationHeader } from "../../utils/gitea-webhook-auth";

export interface GiteaHookConfiguration {
    url: string,
    content_type: string,
    is_system_webhook: string
}

export interface GiteaHookDefinition {
    id?: number,
    type?: string,
    active?: boolean,
    events: string[],
    branch_filter?: string,
    authorization_header?: string,
    config: GiteaHookConfiguration
}

export class GiteaHookSetup {
    private static readonly TAG = "GiteaHookSetup"

    private static getAdminHooksConfig(): { [key: string]: GiteaHookDefinition } {
        const authorizationHeader = getGiteaWebhookAuthorizationHeader();
        return {
            "people-portal-repohook": {
                events: ["repository"],
                authorization_header: authorizationHeader,
                config: {
                    url: `${process.env.PEOPLEPORTAL_WEBHOOK_URL}/api/webhook/git/repoevent`,
                    content_type: 'json',

                    /* Fails if true instead of 'true'. Undocumented API: https://github.com/go-gitea/gitea/pull/33180 */
                    is_system_webhook: "true",
                }
            },

            "people-portal-commithook": {
                events: ["push"],
                branch_filter: "main",
                authorization_header: authorizationHeader,
                config: {
                    url: `${process.env.PEOPLEPORTAL_WEBHOOK_URL}/api/webhook/git/commitevent`,
                    content_type: 'json',
                    is_system_webhook: "true",
                }
            }
        };
    }

    /**
     * Fetches the list of currently configured hooks and adds new People Portal
     * hooks if it doesn't exist, and repairs the authorization header on
     * existing People Portal hooks.
     * 
     * @param giteaBaseConfig Gitea Base Request Configuration
     */
    public static async setupHooks(giteaBaseConfig: any) {
        const adminHooksConfig = this.getAdminHooksConfig();
        /* Get List of Hooks */
        var getHooksRequestConfig = {
            ...giteaBaseConfig,
            method: 'get',
            url: `/api/v1/admin/hooks`,
            params: {
                type: "all",
                limit: 1000
            }
        }

        const hooksResponse = await axios.request(getHooksRequestConfig)
        const existingHooks = new Set<string>();

        for (const hook of hooksResponse.data as GiteaHookDefinition[]) {
            existingHooks.add(hook.config.url)

            const expectedHook = Object.values(adminHooksConfig)
                .find((hookInfo) => hookInfo.config.url === hook.config.url);
            if (expectedHook && hook.id !== undefined) {
                /* Gitea does not return the configured secret. Reapply the
                 * definition so existing hooks receive secret rotations too. */
                await axios.request({
                    ...giteaBaseConfig,
                    method: 'patch',
                    url: `/api/v1/admin/hooks/${hook.id}`,
                    data: {
                        type: "gitea",
                        active: true,
                        ...expectedHook
                    }
                });
            }
        }

        for (const hookName in adminHooksConfig) {
            var hookInfo = adminHooksConfig[hookName]!;
            if (existingHooks.has(hookInfo.config.url))
                continue; /* We Skip if empty too as it doesn't matter! */

            /* Org Doesn't Exist */
            var RequestConfig: any = {
                ...giteaBaseConfig,
                method: 'post',
                url: `/api/v1/admin/hooks`,
                data: {
                    type: "gitea",
                    active: true,
                    ...hookInfo
                }
            }

            /* Excecute Request */
            await axios.request(RequestConfig)
        }

        /* Log */
        log.info(this.TAG, `Hooks Setup Complete: ${Object.keys(adminHooksConfig).join(", ")}`);
    }
}
