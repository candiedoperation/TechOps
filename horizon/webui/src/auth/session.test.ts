import { afterEach, describe, expect, it } from "vitest"

import { authHeaders, clearOperatorToken, hasOperatorToken, resolveAuthToken, setOperatorToken } from "./session"
import type { HorizonTokenSource } from "@/commons/config"

function hostWindow(token?: HorizonTokenSource): Window {
  return { PHI_API_TOKEN: token } as unknown as Window
}

afterEach(() => clearOperatorToken())

describe("operator session token", () => {
  it("keeps the token out of every browser storage API", () => {
    setOperatorToken("secret-token")
    expect(hasOperatorToken()).toBe(true)
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    expect(document.cookie).toBe("")
  })

  it("drops the token on sign-out", async () => {
    setOperatorToken("secret-token")
    clearOperatorToken()
    expect(hasOperatorToken()).toBe(false)
    expect(await resolveAuthToken(hostWindow())).toBeNull()
  })

  it("treats a blank sign-in as no session at all", () => {
    setOperatorToken("   ")
    expect(hasOperatorToken()).toBe(false)
  })
})

describe("window.PHI_API_TOKEN", () => {
  it("accepts a plain string", async () => {
    expect(await resolveAuthToken(hostWindow("host-token"))).toBe("host-token")
  })

  it("accepts a synchronous provider function", async () => {
    expect(await resolveAuthToken(hostWindow(() => "provider-token"))).toBe("provider-token")
  })

  it("accepts an async provider function", async () => {
    expect(await resolveAuthToken(hostWindow(async () => "async-token"))).toBe("async-token")
  })

  it("treats a provider that returns nothing as an unauthenticated page", async () => {
    expect(await resolveAuthToken(hostWindow(async () => null))).toBeNull()
  })

  it("surfaces a failing provider instead of silently sending no token", async () => {
    const failing = () => {
      throw new Error("The host session expired.")
    }
    await expect(resolveAuthToken(hostWindow(failing))).rejects.toThrow("The host session expired.")
  })

  it("lets an operator sign-in override the host token", async () => {
    setOperatorToken("operator-token")
    expect(await resolveAuthToken(hostWindow("host-token"))).toBe("operator-token")
  })
})

describe("authHeaders", () => {
  it("sends nothing when the page has no session, so local demo mode still works", async () => {
    expect(await authHeaders(hostWindow())).toEqual({})
  })

  it("adds the Bearer prefix when the token does not carry it", async () => {
    expect(await authHeaders(hostWindow("abc123"))).toEqual({ Authorization: "Bearer abc123" })
  })

  it("does not double-prefix a token that already says Bearer", async () => {
    expect(await authHeaders(hostWindow("Bearer abc123"))).toEqual({ Authorization: "Bearer abc123" })
  })

  it("never sends X-Reviewer-Id: the server assigns reviewer identity", async () => {
    const headers = await authHeaders(hostWindow("abc123"))
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("x-reviewer-id")
  })
})
