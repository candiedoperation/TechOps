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

export class ResourceAccessError extends Error {
    constructor(public status: number, public message: string) {
        super(message);
        this.name = "ResourceAccessError";
        Object.setPrototypeOf(this, ResourceAccessError.prototype);
    }
}

export class CustomValidationError extends Error {
    constructor(public status: number, public message: string) {
        super(message);
        this.name = "CustomValidationError";
        Object.setPrototypeOf(this, CustomValidationError.prototype);
    }
}

export class SharedResourcesError extends Error {
    constructor(public status: number, public message: string) {
        super(message);
        this.name = "SharedResourcesError";
        Object.setPrototypeOf(this, SharedResourcesError.prototype);
    }
}
/**
 * Renders an unknown thrown value as something a human can read.
 *
 * `String(e)` and `e.toString()` both yield "[object Object]" for a plain
 * object, which is how a rejected API response used to reach the logs with its
 * contents erased. Errors keep their message; anything else is serialised.
 */
export function describeUnknownError(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    if (e === null || e === undefined) return "";
    try {
        const serialized = JSON.stringify(e);
        /* JSON.stringify returns undefined for functions and symbols. */
        return serialized ?? Object.prototype.toString.call(e);
    } catch {
        /* Circular references, or a throwing toJSON. */
        return Object.prototype.toString.call(e);
    }
}
