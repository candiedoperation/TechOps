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

import crypto from 'crypto';
import { CustomValidationError } from './errors';

export function generateSecureRandomString(length: number) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export function sanitizeGroupName(str: string) {
  // Remove all non-alphanumeric and non-hyphen characters
  // \w matches [A-Za-z0-9_], so replace underscores by removing them after
  // [^-] will exclude anything that isn't a letter, a number, or a hyphen/underscore

  let sanitized = str.replace(/[^A-Za-z0-9-_]/g, '');
  return sanitized;
}

/**
 * Title-cases each word, with two deliberate exceptions: a word containing no
 * lowercase letters is left alone (so "UI/UX" and "USA" survive), as is an
 * acronym plural ("PMs", "APIs").
 *
 * Example: "ada lovelace" -> "Ada Lovelace", "HELLO wORLD" -> "HELLO World"
 * ("HELLO" has no lowercase, so it is treated as an acronym and preserved.)
 */
export function capitalizeString(str: string): string {
  if (!str) return str;
  return str.split(' ').map(word => {
    if (word.length === 0) return "";

    // 1. Preserve All Caps or Symbols (No lowercase letters)
    // Example: "UI/UX", "HELLO", "USA"
    if (/^[^a-z]*$/.test(word)) return word;

    // 2. Preserve Acronym Plurals
    // Example: "PMs", "SWEs", "APIs"
    if (/^[A-Z]+s$/.test(word)) return word;

    // 3. Default: Title Case (First Upper, Rest Lower)
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

/**
 * Normalizes a full name into FirstLast format, removing middle names and hyphens while capitalizing segments.
 */
export function sanitizeUserFullName(fullName: string): string {
  if (!fullName || typeof fullName !== 'string') return '';

  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return '';

  const firstNameRaw = parts[0] ?? '';
  const lastNameRaw = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';

  const normalizeSegment = (str: string): string => {
    if (!str) return '';
    return str.split('-').map(segment => {
      return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
    }).join('');
  };

  /* The result becomes an AWS IAM session name, which permits only
     [\w+=,.@-]. Apostrophes survived normalizeSegment, so "Mary-Kate O'Neil"
     produced "MaryKateO'neil" and STS rejected the console link outright. */
  const toSessionSafe = (str: string): string => str.replace(/[^\w+=,.@-]/g, '');

  return toSessionSafe(normalizeSegment(firstNameRaw) + normalizeSegment(lastNameRaw));
}

/**
 * Validates a human full name coming from the frontend.
 * - Trims whitespace
 * - Enforces length between 2 and 60 characters
 * - Allows letters, spaces, apostrophes, periods, and hyphens
 * - Must contain at least one letter
 * Returns the trimmed name if valid; throws CustomValidationError otherwise.
 */
export function validatePersonName(name: string): string {
  const trimmed = (name ?? '').trim();

  if (trimmed.length < 2 || trimmed.length > 60) {
    throw new CustomValidationError(
      400,
      'Invalid name. Must be between 2 and 60 characters.'
    );
  }

  // Allow letters in any case, spaces, apostrophes, periods, and hyphens
  const allowed = /^[A-Za-z .'-]+$/;
  if (!allowed.test(trimmed)) {
    throw new CustomValidationError(
      400,
      "Invalid name. Use only letters, spaces, apostrophes, periods, and hyphens."
    );
  }

  // Enforce presence of first and last name (at least two name parts with letters)
  // Example valid: "Jane Doe", "Mary-Kate O'Neil", "J. Smith"
  const parts = trimmed.split(/\s+/).filter(p => p.length > 0);
  const alphaParts = parts.filter(p => /[A-Za-z]/.test(p));
  if (alphaParts.length < 2) {
    throw new CustomValidationError(400, 'Please enter a first and last name.');
  }

  return trimmed;
}

/**
 * Formats a bindle access error message listing team owners and missing bindles.
 */
export function formatBindleAccessError(owners: string[], missingBindles: string[]): string {
  const formatList = (items: string[], conjunction: string) => {
    if (items.length === 0) return "";
    if (items.length === 1) return items[0];
    const last = items[items.length - 1];
    const rest = items.slice(0, -1).join(", ");
    return `${rest} ${conjunction} ${last}`;
  };

  const ownersStr = formatList(owners, "or") || "an administrator";
  const bindlesStr = formatList(missingBindles, "and");

  return `You do not have permission to access this resource. Please ask ${ownersStr} to grant you the ${bindlesStr} bindle${missingBindles.length === 1 ? "" : "s"}.`;
}

/**
 * Validates a team name ensuring it contains only letters, numbers, spaces, and apostrophes.
 * Also formats the name to Title Case (capitalizing the first letter of each word).
 * @param name Team Name
 * @returns Formatted Team Name
 * @throws Error if invalid
 */
export function validateTeamName(name: string): string {
  if (name.length < 3 || name.length > 25) {
    throw new CustomValidationError(
      400,
      "Invalid Team Name. Must be between 3 and 25 characters."
    );
  }

  // Allow letters, numbers, spaces, and apostrophes
  const regex = /^[a-zA-Z0-9' ]+$/;
  if (!regex.test(name)) {
    throw new CustomValidationError(
      400,
      "Invalid Team Name. Use only letters, numbers, spaces, and apostrophes."
    );
  }

  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(name)) {
    throw new CustomValidationError(
      400,
      "Invalid Team Name. Must contain at least one letter."
    );
  }

  // Title Case Formatting
  return name.split(' ').map(word => {
    if (word.length === 0) return "";
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

/**
 * Returns the GPL v3 license text for People Portal Server with a Dynamic Year.
 * @returns GPL v3 License Text
 */
export function getGPLv3License() {
  return `People Portal Server
Copyright (C) ${new Date().getFullYear()}  Atheesh Thirumalairajan

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.`;
}