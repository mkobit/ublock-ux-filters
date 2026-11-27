import { describe, expect, test } from "bun:test";
import { classifyNavigationFailure } from "./webdriver.ts";

describe("webdriver error classification", () => {
  test("classifies HTTP 403, 429, and 503 as BOT_CHALLENGE", () => {
    expect(classifyNavigationFailure({ httpStatus: 403 })?.kind).toBe("BOT_CHALLENGE");
    expect(classifyNavigationFailure({ httpStatus: 429 })?.kind).toBe("BOT_CHALLENGE");
    expect(classifyNavigationFailure({ httpStatus: 503 })?.kind).toBe("BOT_CHALLENGE");
  });

  test("classifies CAPTCHA and challenge text as BOT_CHALLENGE", () => {
    expect(
      classifyNavigationFailure({
        httpStatus: 200,
        title: "Just a moment...",
        bodyText: "Please verify you are human to continue.",
      })?.kind,
    ).toBe("BOT_CHALLENGE");

    expect(
      classifyNavigationFailure({
        httpStatus: 200,
        title: "Attention Required! | Cloudflare",
      })?.kind,
    ).toBe("BOT_CHALLENGE");

    expect(
      classifyNavigationFailure({
        httpStatus: 200,
        bodyText: "Access Denied - CAPTCHA required",
      })?.kind,
    ).toBe("BOT_CHALLENGE");
  });

  test("classifies other 4xx/5xx statuses as HTTP_ERROR", () => {
    expect(classifyNavigationFailure({ httpStatus: 404 })?.kind).toBe("HTTP_ERROR");
    expect(classifyNavigationFailure({ httpStatus: 500 })?.kind).toBe("HTTP_ERROR");
  });

  test("classifies navigation and selector timeouts", () => {
    expect(
      classifyNavigationFailure({ httpStatus: null, timedOutPhase: "navigation" })?.kind,
    ).toBe("NAVIGATION_TIMEOUT");
    expect(
      classifyNavigationFailure({ httpStatus: 200, timedOutPhase: "selector" })?.kind,
    ).toBe("SELECTOR_TIMEOUT");
  });

  test("returns null for healthy 200 response", () => {
    expect(
      classifyNavigationFailure({
        httpStatus: 200,
        title: "Hacker News",
        bodyText: "Show HN: Something cool",
      }),
    ).toBeNull();
  });
});
