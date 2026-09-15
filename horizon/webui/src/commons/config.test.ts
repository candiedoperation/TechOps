import { describe, expect, it } from "vitest"

import { resolveApiBase } from "./config"

/** A minimal stand-in for `window` with just the fields resolveApiBase reads. */
function fakeWindow(protocol: string, origin: string, configured?: unknown): Window {
  return {
    location: { protocol, origin },
    PHI_API_BASE: configured,
  } as unknown as Window
}

describe("resolveApiBase", () => {
  it("defaults to the page origin, so a same-origin deployment needs no config", () => {
    expect(resolveApiBase(fakeWindow("https:", "https://horizon.example.org"))).toBe(
      "https://horizon.example.org",
    )
  })

  it("falls back to the local API for file: pages, which have no useful origin", () => {
    expect(resolveApiBase(fakeWindow("file:", "null"))).toBe("http://127.0.0.1:8000")
  })

  it("honours an explicit PHI_API_BASE from the host integration", () => {
    expect(
      resolveApiBase(fakeWindow("https:", "https://portal.example.org", "https://api.example.org")),
    ).toBe("https://api.example.org")
  })

  it("strips a trailing slash so paths cannot become //snapshots/latest", () => {
    expect(
      resolveApiBase(fakeWindow("https:", "https://portal.example.org", "https://api.example.org/")),
    ).toBe("https://api.example.org")
  })

  it("ignores a blank override rather than requesting a relative-looking base", () => {
    expect(resolveApiBase(fakeWindow("https:", "https://horizon.example.org", "   "))).toBe(
      "https://horizon.example.org",
    )
  })
})
