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

import mongoose from "mongoose";
import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";
import { DefinedJobs, JobSchedulingData, RecurringJobs } from "./Jobs";



export class AgendaClient {
    private static readonly TAG = "AgendaClient";
    private agenda: Agenda | undefined;

    
    constructor() { 
        this.agenda = undefined;
    }

    // Agenda will query MongoDB every dbQueryInterval (default 15 minutes)
    // to look for pending jobs. If the interval is small, too many requests
    // will be made to the MongoDB server.
    public async initialize(dbQueryInterval?: string): Promise<void> {

        if (dbQueryInterval === undefined) {
            dbQueryInterval = "10 minutes";
        }
        this.agenda = new Agenda({
            backend: new MongoBackend({
                mongo: mongoose.connection.db!,
            }),
            processEvery: dbQueryInterval,
        });


        // Define all jobs
        Object.entries(DefinedJobs).map((entry) => {
            const key = entry[0];
            const job = entry[1];
            this.agenda!.define(key, job.workerFunction, job.options);
        });

        for(const entry of RecurringJobs) {
            // Agenda automatically checks for duplicates.
            /* Awaited: an unawaited every() swallowed scheduling failures, so a
               recurring job could silently never be registered. */
            await this.agenda.every(
                entry.schedule,
                entry.jobName,
                entry.jobPayload,
                entry.options
            );
        }

        await this.agenda.start();
    }

    // Schedule a job to be run one time.
    public async scheduleJobOnce(jobData: JobSchedulingData) {
        await this.agenda!.schedule(
          jobData.runAt,
          jobData.jobName,
          jobData.jobPayload,
          jobData.options
        );
    }

    public async cancelJob(jobName: string, jobData: object) {
        await this.agenda!.cancel({ name: jobName, data: jobData });
    }
}

export const agendaClient = new AgendaClient();