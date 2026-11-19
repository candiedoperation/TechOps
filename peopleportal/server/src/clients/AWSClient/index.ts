/**
  People Portal Server
  Copyright (C) 2026  Atheesh Thirumalairajan
  Copyright (C) 2025  Ian Coutinho

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

import { RootTeamSettingClient } from "..";
import { RootTeamSettingMap } from "../../controllers/OrgController";
import { GetGroupInfoResponse } from "../AuthentikClient/models";
import {
    OrganizationsClient,
    CreateAccountCommand,
    DescribeCreateAccountStatusCommand,
    MoveAccountCommand,
    ListParentsCommand,
    paginateListAccountsForParent
} from "@aws-sdk/client-organizations";
import {
    BudgetsClient,
    CreateBudgetCommand,
    CreateBudgetActionCommand,
    DeleteBudgetCommand,
    BudgetType,
    TimeUnit,
    ThresholdType,
    NotificationType,
    ComparisonOperator,
    ActionType
} from "@aws-sdk/client-budgets";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import axios from "axios";

export class AWSClient implements RootTeamSettingClient {
    private static readonly TAG = "AWSClient"

    private orgClient: OrganizationsClient;
    private budgetsClient: BudgetsClient;
    private stsClient: STSClient;

    private readonly REGION = process.env.AWS_REGION ?? "us-east-1";
    private readonly ROOT_ID = process.env.AWS_ORG_ROOT_ID;
    private readonly NONPROD_OU_ID = process.env.AWS_NONPROD_OU_ID;
    private readonly SUSPENDED_OU_ID = process.env.AWS_SUSPENDED_OU_ID;
    private readonly MANAGEMENT_ACCOUNT_ID = process.env.AWS_MANAGEMENT_ACCOUNT_ID;
    private readonly ADMIN_ROLE_NAME = process.env.AWS_ADMIN_ROLE_NAME ?? "AppDevNonProductionRole";
    private readonly BUDGET_LIMIT = process.env.AWS_DEFAULT_BUDGET_AMOUNT ?? "50";
    private readonly BILLING_ALERT_EMAIL = process.env.AWS_BILLING_ALERT_EMAIL ?? "awsclient+financealerts@appdevclub.com";
    private readonly DENY_ALL_SCP_ID = process.env.AWS_DENY_ALL_SCP_ID;
    private readonly BUDGET_ACTION_ROLE_ARN = process.env.AWS_BUDGET_ACTION_ROLE_ARN;
    private readonly SESSION_EXPIRY = 3600;


    private readonly SUPPORTED_ROOTSETTINGS: RootTeamSettingMap = {
        "awsclient:provision": {
            friendlyName: "Provision AWS Account",
            description: "Creates a new AWS Account just for your team"
        }
    }

    constructor() {
        if (!this.ROOT_ID || !this.NONPROD_OU_ID || !this.MANAGEMENT_ACCOUNT_ID) {
            throw new Error(`${AWSClient.TAG}: Missing critical AWS environment variables. AWS features will fail.`);
        }

        this.orgClient = new OrganizationsClient({ region: this.REGION });
        this.budgetsClient = new BudgetsClient({ region: this.REGION });
        this.stsClient = new STSClient({ region: this.REGION });
    }

    getResourceName(): string {
        return AWSClient.TAG;
    }

    getSupportedSettings(): RootTeamSettingMap {
        return this.SUPPORTED_ROOTSETTINGS;
    }

    async syncSettingUpdate(org: GetGroupInfoResponse): Promise<boolean> {
        const settings = org.attributes.rootTeamSettings?.[this.getResourceName()];
        const shouldProvision = settings && settings["awsclient:provision"] === true;

        if (!shouldProvision) {
            console.debug("[AWS_CLIENT] 100%: AWS Provisioning is disabled for this team.");
            return true;
        }

        const name = org.name;

        try {
            // Check for existing account
            console.debug(`[AWS_CLIENT] 10%: Checking for existing account: ${name}...`);
            const existingAccountId = await this.findAccountIdByName(name);

            if (existingAccountId) {
                console.debug(`[AWS_CLIENT] 100%: Account already exists (${existingAccountId}). No action taken.`);
                return true;
            }

            // Create Account
            const adminEmail = `awsclient+${name.toLowerCase()}@appdevclub.com`;
            console.debug(`[AWS_CLIENT] 20%: Creating AWS Account (${adminEmail})...`);

            const accountId = await this.createAccount(name, adminEmail);
            if (!accountId) throw new Error("Account creation returned no ID.");

            // Move to OU
            console.debug("[AWS_CLIENT] 60%: Moving account to Non Production OU...");
            await this.moveAccount(accountId);

            // Create Budget
            console.debug("[AWS_CLIENT] 80%: Applying Budget...");

            // Use the first user's email for alerts, or fallback to the finance email
            const alertEmail = this.BILLING_ALERT_EMAIL;
            console.log(`Using ${alertEmail} for billing alerts for ${name}`);
            await this.createBudget(accountId, alertEmail, name, this.BUDGET_LIMIT);

            console.debug(`[AWS_CLIENT] 100%: Successfully provisioned AWS Account: ${accountId}`);
            return true;
        } catch (e: any) {
            console.error(e);
            console.debug(`[AWS_CLIENT] 100%: AWS Provisioning Failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Archives the team's AWS account by moving it to the Suspended OU and
     * deleting its monthly budget. The account and all its data are preserved;
     * only billing is stopped and the account is isolated from active OUs.
     *
     * @param org Team Information
     */
    async archiveTeam(org: GetGroupInfoResponse): Promise<boolean> {
        const settings = org.attributes.rootTeamSettings?.[this.getResourceName()];
        const isProvisioned = settings && settings["awsclient:provision"] === true;

        if (!isProvisioned) {
            console.debug("[AWS_CLIENT] Archive: AWS not provisioned for this team, skipping.");
            return true;
        }

        if (!this.SUSPENDED_OU_ID) {
            throw new Error("AWS_SUSPENDED_OU_ID is not configured; cannot archive team account.");
        }

        const accountId = await this.findAccountIdByName(org.name);
        if (!accountId) {
            console.debug(`[AWS_CLIENT] Archive: No AWS account found for team '${org.name}', skipping.`);
            return true;
        }

        /* Move account to Suspended OU, resolving current parent dynamically */
        const parentsRes = await this.orgClient.send(new ListParentsCommand({ ChildId: accountId }));
        const currentParentId = parentsRes.Parents?.[0]?.Id;
        if (!currentParentId) {
            throw new Error(`[AWS_CLIENT] Archive: Could not determine parent OU for account ${accountId}.`);
        }

        if (currentParentId !== this.SUSPENDED_OU_ID) {
            await this.orgClient.send(new MoveAccountCommand({
                AccountId: accountId,
                SourceParentId: currentParentId,
                DestinationParentId: this.SUSPENDED_OU_ID
            }));
            console.debug(`[AWS_CLIENT] Archive: Moved account ${accountId} to Suspended OU.`);
        } else {
            console.debug(`[AWS_CLIENT] Archive: Account ${accountId} already in Suspended OU.`);
        }

        /* Delete the monthly budget — best-effort, not fatal if missing */
        try {
            await this.budgetsClient.send(new DeleteBudgetCommand({
                AccountId: this.MANAGEMENT_ACCOUNT_ID,
                BudgetName: `Project-Budget-${org.name}`
            }));
            console.debug(`[AWS_CLIENT] Archive: Deleted budget for ${org.name}.`);
        } catch (e: any) {
            if (e.name !== 'NotFoundException') {
                console.warn(`[AWS_CLIENT] Archive: Could not delete budget: ${e.message}`);
            }
        }

        return true;
    }

    public async generateConsoleLink(accountId: string, sessionName: string): Promise<string> {
        // Assume Admin Role
        const roleArn = `arn:aws:iam::${accountId}:role/${this.ADMIN_ROLE_NAME}`;
        const cleanSessionName = sessionName.replace(/[^a-zA-Z0-9_+=,.@-]/g, '-').substring(0, 64);

        const assumeRes = await this.stsClient.send(new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: cleanSessionName.substring(0, 64),
            DurationSeconds: this.SESSION_EXPIRY
        }));

        if (!assumeRes.Credentials) {
            throw new Error("Failed to obtain temporary credentials.");
        }

        // Prepare Federation JSON
        const sessionJson = JSON.stringify({
            sessionId: assumeRes.Credentials.AccessKeyId,
            sessionKey: assumeRes.Credentials.SecretAccessKey,
            sessionToken: assumeRes.Credentials.SessionToken
        });

        // Get Signin Token
        const fedUrl = `https://signin.aws.amazon.com/federation?Action=getSigninToken&Session=${encodeURIComponent(sessionJson)}`;
        const response = await axios.get(fedUrl);
        const token = response.data.SigninToken;

        // Build URL
        const destination = `https://${this.REGION}.console.aws.amazon.com/console/home?region=${this.REGION}`;
        return `https://signin.aws.amazon.com/federation?Action=login&Issuer=AppDevPortal&Destination=${encodeURIComponent(destination)}&SigninToken=${token}`;
    }

    // private helper methods
    private async createAccount(name: string, email: string): Promise<string> {
        const createCmd = new CreateAccountCommand({
            Email: email,
            AccountName: name,
            RoleName: this.ADMIN_ROLE_NAME,
            IamUserAccessToBilling: "DENY"
        });

        const createRes = await this.orgClient.send(createCmd);
        const requestId = createRes.CreateAccountStatus?.Id;

        if (!requestId) throw new Error("Failed to initiate account creation");

        const startTime = Date.now();
        const timeoutMs = 300000; // 5 minutes

        while (true) {
            if (Date.now() - startTime > timeoutMs) {
                throw new Error(`Account creation timed out. Request ID: ${requestId}. Check AWS Console for status.`);
            }

            await new Promise(r => setTimeout(r, 3000));

            const statusCmd = new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: requestId });
            const statusRes = await this.orgClient.send(statusCmd);
            const state = statusRes.CreateAccountStatus?.State;

            if (state === "SUCCEEDED") {
                return statusRes.CreateAccountStatus!.AccountId!;
            } else if (state === "FAILED") {
                throw new Error(`AWS Creation Failed: ${statusRes.CreateAccountStatus?.FailureReason}`);
            }

            console.debug("[AWS_CLIENT] 30%: Waiting for AWS to finalize account creation...");
        }
    }

    private async moveAccount(accountId: string) {
        await this.orgClient.send(new MoveAccountCommand({
            AccountId: accountId,
            SourceParentId: this.ROOT_ID,
            DestinationParentId: this.NONPROD_OU_ID
        }));
    }

    private async createBudget(accountId: string, email: string, projectName: string, budgetLimit: string) {
        await new Promise(r => setTimeout(r, 5000));

        const budgetName = `Project-Budget-${projectName}`;

        await this.budgetsClient.send(new CreateBudgetCommand({
            AccountId: this.MANAGEMENT_ACCOUNT_ID,
            Budget: {
                BudgetName: budgetName,
                BudgetType: BudgetType.Cost,
                TimeUnit: TimeUnit.MONTHLY,
                BudgetLimit: { Amount: budgetLimit, Unit: "USD" },
                CostFilters: { "LinkedAccount": [accountId] }
            },
            NotificationsWithSubscribers: [
                {
                    Notification: {
                        NotificationType: NotificationType.ACTUAL,
                        ComparisonOperator: ComparisonOperator.GREATER_THAN,
                        Threshold: 80,
                        ThresholdType: ThresholdType.PERCENTAGE
                    },
                    Subscribers: [{ SubscriptionType: "EMAIL", Address: email }]
                }
            ]
        }));

        await this.createBudgetEnforcementAction(accountId, budgetName);
    }

    /**
     * Attaches a Budget Action that automatically applies a Deny-All SCP to the
     * account when actual spend reaches 100% of the budget. This stops all AWS
     * activity in the account without deleting any resources.
     *
     * Requires AWS_DENY_ALL_SCP_ID and AWS_BUDGET_ACTION_ROLE_ARN to be set.
     * If either is missing the action is skipped with a warning.
     */
    private async createBudgetEnforcementAction(accountId: string, budgetName: string) {
        if (!this.DENY_ALL_SCP_ID || !this.BUDGET_ACTION_ROLE_ARN) {
            console.warn("[AWS_CLIENT] AWS_DENY_ALL_SCP_ID or AWS_BUDGET_ACTION_ROLE_ARN not set; budget enforcement action skipped.");
            return;
        }

        await this.budgetsClient.send(new CreateBudgetActionCommand({
            AccountId: this.MANAGEMENT_ACCOUNT_ID,
            BudgetName: budgetName,
            NotificationType: NotificationType.ACTUAL,
            ActionType: ActionType.SCP,
            ActionThreshold: {
                ActionThresholdValue: 100,
                ActionThresholdType: "PERCENTAGE"
            },
            Definition: {
                ScpActionDefinition: {
                    PolicyId: this.DENY_ALL_SCP_ID,
                    TargetIds: [accountId]
                }
            },
            ExecutionRoleArn: this.BUDGET_ACTION_ROLE_ARN,
            ApprovalModel: "AUTOMATIC",
            Subscribers: [{ SubscriptionType: "EMAIL", Address: this.BILLING_ALERT_EMAIL }]
        }));

        console.debug(`[AWS_CLIENT] Budget enforcement action created for account ${accountId}.`);
    }

    public async findAccountIdByName(name: string): Promise<string | undefined> {
        const TIMEOUT_MS = 30000; // 30 second timeout

        const findAccount = async (): Promise<string | undefined> => {
            const config = { client: this.orgClient };
            const input = { ParentId: this.NONPROD_OU_ID };

            const paginator = paginateListAccountsForParent(config, input);

            for await (const page of paginator) {
                const accounts = page.Accounts || [];

                const match = accounts.find((a) => a.Name === name);

                if (match) {
                    return match.Id;
                }
            }

            // just in case the account was created but not moved
            const rootPaginator = paginateListAccountsForParent({ client: this.orgClient }, { ParentId: this.ROOT_ID });

            for await (const page of rootPaginator) {
                const match = (page.Accounts || []).find((a) => a.Name === name);
                if (match) {
                    await this.moveAccount(match.Id!);
                    return match.Id;
                }
            }

            // check suspended OU so archived accounts aren't re-provisioned
            if (this.SUSPENDED_OU_ID) {
                const suspendedPaginator = paginateListAccountsForParent({ client: this.orgClient }, { ParentId: this.SUSPENDED_OU_ID });

                for await (const page of suspendedPaginator) {
                    const match = (page.Accounts || []).find((a) => a.Name === name);
                    if (match) return match.Id;
                }
            }

            return undefined;
        };

        // Wrap in timeout to prevent indefinite hangs
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`AWS account lookup timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
        });

        return Promise.race([findAccount(), timeoutPromise]);
    }



}