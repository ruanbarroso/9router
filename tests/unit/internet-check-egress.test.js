import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The probe is a raw net.Socket, so the fail-closed egress policy never sees
// it: it reaches the kernel, the firewall REJECTs it, and the only trace is a
// KROUTER-EGRESS-BLOCKED line — once per watchdog tick, forever.
describe("checkInternet under a proxy-required host", () => {
  let connectSpy;

  beforeEach(async () => {
    vi.resetModules();
    const net = (await import("net")).default;
    connectSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function () {
      return this;
    });
  });

  afterEach(() => {
    connectSpy.mockRestore();
    delete process.env.NINEROUTER_REQUIRE_PROXY;
    delete process.env.KROUTER_REQUIRE_PROXY;
  });

  it("does not open a socket when NINEROUTER_REQUIRE_PROXY is set", async () => {
    process.env.NINEROUTER_REQUIRE_PROXY = "1";
    const { checkInternet } = await import("@/lib/tunnel/shared/internetCheck.js");

    await expect(checkInternet()).resolves.toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("honours the deprecated KROUTER_REQUIRE_PROXY alias the live unit still sets", async () => {
    process.env.KROUTER_REQUIRE_PROXY = "true";
    const { checkInternet } = await import("@/lib/tunnel/shared/internetCheck.js");

    await expect(checkInternet()).resolves.toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("announces the skip once, not once per watchdog tick", async () => {
    process.env.NINEROUTER_REQUIRE_PROXY = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { checkInternet } = await import("@/lib/tunnel/shared/internetCheck.js");

    await checkInternet();
    await checkInternet();
    await checkInternet();

    expect(log.mock.calls.filter(([m]) => String(m).includes("internet probe skipped"))).toHaveLength(1);
    log.mockRestore();
  });

  it("still dials when no proxy is required", async () => {
    const { checkInternet } = await import("@/lib/tunnel/shared/internetCheck.js");

    // connect is stubbed and never fires an event, so the promise stays pending;
    // the assertion is that the dial was attempted at all.
    checkInternet();
    await Promise.resolve();
    expect(connectSpy).toHaveBeenCalledWith(443, "1.1.1.1");
  });
});
