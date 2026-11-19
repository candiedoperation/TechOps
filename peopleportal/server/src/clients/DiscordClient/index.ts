/**
  People Portal Server
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

import { Client, Events, GatewayIntentBits, GuildBasedChannel } from 'discord.js'
import { SharedResourceClient } from '..';
import { BindlePermissionMap } from '../../controllers/BindleController';
import { GetGroupInfoResponse } from '../AuthentikClient/models';


export class DiscordClient implements SharedResourceClient {
    private static readonly TAG = "DiscordClient";
    private static readonly INTENTS = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ];
    /* Null when the integration is disabled: see the constructor. */
    private readonly discordClient: Client | null;

    /**
     * False when Discord is not configured. Every method below is a safe no-op
     * in that state, so callers do not need to check it.
     */
    public readonly enabled: boolean;

    private readonly supportedBindles: BindlePermissionMap = {};

    public isReady: boolean;

    constructor() {
        this.isReady = false;

        /* This runs at import time, via ENABLED_SHARED_RESOURCES in config.ts,
           so throwing here kills the process before Express ever listens.
           A Discord integration that is not configured must disable Discord,
           not the server: these variables are absent from the deployment's
           .env template, so a missing one is the likely case, not the
           exceptional one. */
        const token = process.env.PEOPLEPORTAL_DISCORD_BOT_TOKEN;
        const serverId = process.env.PEOPLEPORTAL_DISCORD_SERVER_ID;
        const missing = [
            !token && "PEOPLEPORTAL_DISCORD_BOT_TOKEN",
            !serverId && "PEOPLEPORTAL_DISCORD_SERVER_ID",
        ].filter(Boolean);

        if (missing.length > 0) {
            this.enabled = false;
            this.discordClient = null;
            console.warn(
                `${DiscordClient.TAG}: ${missing.join(" and ")} not set; Discord integration disabled.`
            );
            return;
        }

        this.enabled = true;
        this.discordClient = new Client({ intents: DiscordClient.INTENTS });
        this.discordClient.on(Events.ClientReady, () => this.isReady = true);
        /* login() is async and rejects on a bad/expired token. Unhandled, that
           rejection killed the process at import time, before Express ever
           listened, turning a Discord credential problem into a full outage.
           Degrade to a disabled Discord integration instead. */
        this.discordClient.login(process.env.PEOPLEPORTAL_DISCORD_BOT_TOKEN)
            .catch((e) => {
                console.error("DiscordClient: login failed, Discord integration disabled:", e?.message ?? e);
            });
    }

    async init(): Promise<void> {
        if (!this.enabled) return;

        /* waitForReady() rejects after 15s when the gateway never connects. That
           rejection used to propagate out of the startup loop and kill the
           process. A Discord outage should disable Discord, not People Portal;
           callers already gate on isReady. */
        try {
            await this.waitForReady();
        } catch (e: any) {
            console.error(`${DiscordClient.TAG}: not ready, integration disabled:`, e?.message ?? e);
        }
    }

    waitForReady(): Promise<void> {
        if (!this.enabled || !this.discordClient) return Promise.resolve();

        const client = this.discordClient;
        return new Promise((resolve, reject) => {
            if (client.isReady()) {
                return resolve();
            }

            let timeout: NodeJS.Timeout;

            const onReady = () => {
                clearTimeout(timeout);
                resolve();
            }

            timeout = setTimeout(() => {
                client.off(Events.ClientReady, onReady);
                reject(new Error("Discord bot was not ready on time."));
            }, 15000);
            client.once(Events.ClientReady, onReady);
        });
    }

    getResourceName(): string {
        return DiscordClient.TAG;
    }

    getSupportedBindles(): BindlePermissionMap {
        return this.supportedBindles;
    }

    // Implement later when needed.
    async handleOrgBindleSync(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        return Promise.resolve(true);
    }

    async archiveTeam(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        // TODO: Implement Discord channel archival
        return Promise.resolve(true);
    }

    async getChannelFromName(channelName: string) {
        /* Undefined is the "no such channel" answer callers already handle, so
           a disabled integration looks the same as a missing channel. */
        if (!this.enabled || !this.discordClient) return undefined;

        // Uses guild id in .env in case bot is in multiple servers.
        const guild = await this.discordClient.guilds.fetch(process.env.PEOPLEPORTAL_DISCORD_SERVER_ID!);
        return guild.channels.cache.find(ch => ch.name === channelName && ch.isTextBased());
    }

    async sendMessageInChannel(channel: GuildBasedChannel, message: string) {
        if (channel.isSendable()) {
            return await channel.send(message);
        }
        throw new Error(`Channel ${channel.name} is not sendable.`);
    }
}