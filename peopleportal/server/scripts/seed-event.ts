/**
 * Local fixtures for the event RSVP and attendance tables.
 * These are not Authentik accounts and cannot log in. Writes go directly to
 * MongoDB; authorization, notifications and check-in validation are not tested.
 *
 * From the repository root:
 *   ./nx run pplserver:seed-event --args="<EVENT_ID> 100"
 */
import mongoose from "mongoose";
import { loadEnvironmentFiles, isProduction } from "../src/config/environment";
import { Event } from "../src/models/Event";
import { EventRsvp, RsvpStatus } from "../src/models/EventRsvp";
import { EventAttendance } from "../src/models/EventAttendance";

loadEnvironmentFiles();

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
        console.log('Usage: ./nx run pplserver:seed-event --args="<EVENT_ID> [COUNT]"');
        console.log("COUNT defaults to 100. Requires a local PEOPLEPORTAL_MONGO_URL.");
        return;
    }

    const [rawEventId, rawCount = "100"] = args;
    const count = Number(rawCount);
    const mongoUrl = process.env.PEOPLEPORTAL_MONGO_URL;

    if (isProduction) {
        throw new Error("Use this script only for local development.");
    }

    // Parse the host rather than matching 'localhost' anywhere in the URI.
    let localMongo = false;
    try {
        const url = new URL(mongoUrl ?? "");
        localMongo = url.protocol === "mongodb:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
            url.pathname.length > 1;
    } catch { /* Missing, malformed or multi-host URI: refuse to seed. */ }
    if (!mongoUrl || !localMongo) {
        throw new Error("PEOPLEPORTAL_MONGO_URL must name a database on local MongoDB.");
    }
    if (!rawEventId || !/^[a-f\d]{24}$/i.test(rawEventId) || args.length > 2) {
        throw new Error('Usage: ./nx run pplserver:seed-event --args="<EVENT_ID> [COUNT]"');
    }
    if (!Number.isInteger(count) || count < 1 || count > 10_000) {
        throw new Error("Count must be an integer from 1 to 10000.");
    }

    const eventId = rawEventId.toLowerCase();
    await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 5000 });
    const event = await Event.findById(eventId);
    if (!event) throw new Error("Event not found.");

    const methods = ["qr", "code", "manual"] as const;
    let rsvps = 0;
    let attendees = 0;

    for (let i = 0; i < count; i++) {
        const email = `seed-event-${i}@example.invalid`;
        // Fixture-only IDs; real Authentik users have positive IDs.
        const userPk = -(i + 1);
        const scenario = i % 10;
        const status = scenario < 6 ? RsvpStatus.ACCEPT :
            scenario === 6 ? RsvpStatus.DECLINE : RsvpStatus.CANCEL;

        // Per ten people: six accepts, one decline, one cancel, two walk-ins.
        if (scenario < 8) {
            await EventRsvp.updateOne(
                { eventId, email },
                { $set: { status } },
                { upsert: true, runValidators: true },
            );
            rsvps++;
        }

        // Four accepted attendees and two walk-ins. Two accepts are absent.
        if (scenario < 4 || scenario >= 8) {
            await EventAttendance.updateOne(
                { eventId, userPk },
                {
                    $setOnInsert: {
                        email,
                        checkedInAt: new Date(event.startTime.getTime() + i * 1000),
                        method: methods[i % methods.length]!,
                    },
                },
                { upsert: true, runValidators: true },
            );
            attendees++;
        }
    }

    console.log(`Seeded fixtures for ${event.eventName}: ${rsvps} RSVPs, ${attendees} attendees.`);
    console.log("Re-running reuses fixtures. A smaller count does not remove earlier fixtures.");
}

main()
    .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
