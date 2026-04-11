import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";

import { logger, setLogLevel, type LogLevel } from "../src/logger.js";

// Helper to extract the logged string from the spy.
function lastMessage(spy: MockInstance): string {
  return spy.mock.calls[0]![0] as string;
}

describe("logger", () => {
  let spy: MockInstance;

  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation((): void => undefined);
  });

  afterEach(() => {
    // Reset to the module default so tests don't pollute each other.
    setLogLevel("warn");
    spy.mockRestore();
  });

  // -- Default level ----------------------------------------------------------

  describe("default level", () => {
    it("suppresses debug messages at the default level", () => {
      logger.debug("should not appear");
      expect(spy).not.toHaveBeenCalled();
    });

    it("suppresses info messages at the default level", () => {
      logger.info("should not appear");
      expect(spy).not.toHaveBeenCalled();
    });

    it("allows warn messages at the default level", () => {
      logger.warn("visible warning");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("allows error messages at the default level", () => {
      logger.error("visible error");
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // -- setLogLevel ------------------------------------------------------------

  describe("setLogLevel", () => {
    it("enables debug messages when level is set to debug", () => {
      setLogLevel("debug");
      logger.debug("debug msg");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("enables info messages when level is set to info", () => {
      setLogLevel("info");
      logger.info("info msg");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("suppresses debug and info and warn when level is set to error", () => {
      setLogLevel("error");
      logger.debug("nope");
      logger.info("nope");
      logger.warn("nope");
      expect(spy).not.toHaveBeenCalled();
      logger.error("yes");
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // -- Level filtering --------------------------------------------------------

  describe("level filtering", () => {
    it("logs messages at exactly the current level", () => {
      const levels: LogLevel[] = ["debug", "info", "warn", "error"];
      for (const level of levels) {
        spy.mockClear();
        setLogLevel(level);
        logger[level]("msg");
        expect(spy).toHaveBeenCalledTimes(1);
      }
    });

    it("logs messages above the current level", () => {
      setLogLevel("info");
      logger.warn("above info");
      logger.error("above info");
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("suppresses messages below the current level", () => {
      setLogLevel("warn");
      logger.debug("below warn");
      logger.info("below warn");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -- Output format ----------------------------------------------------------

  describe("output format", () => {
    it("includes an ISO timestamp, uppercase level, and message", () => {
      setLogLevel("debug");
      logger.debug("hello world");

      expect(spy).toHaveBeenCalledTimes(1);
      const output = lastMessage(spy);

      // ISO 8601 timestamp at the start
      expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
      expect(output).toContain("[DEBUG]");
      expect(output).toContain("hello world");
    });

    it("formats each level name in uppercase", () => {
      setLogLevel("debug");

      const cases: { method: LogLevel; tag: string }[] = [
        { method: "debug", tag: "[DEBUG]" },
        { method: "info", tag: "[INFO]" },
        { method: "warn", tag: "[WARN]" },
        { method: "error", tag: "[ERROR]" },
      ];

      for (const { method, tag } of cases) {
        spy.mockClear();
        logger[method]("test");
        const output = lastMessage(spy);
        expect(output).toContain(tag);
      }
    });

    it("writes to console.error, not console.log", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation((): void => undefined);
      setLogLevel("debug");
      logger.debug("stderr only");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  // -- Context serialization --------------------------------------------------

  describe("context serialization", () => {
    it("appends key=value pairs after the message", () => {
      setLogLevel("debug");
      logger.debug("request", { method: "GET", path: "/me" });

      const output = lastMessage(spy);
      expect(output).toContain('method="GET"');
      expect(output).toContain('path="/me"');
    });

    it("serializes numeric values with JSON.stringify", () => {
      setLogLevel("debug");
      logger.debug("stats", { count: 42 });

      const output = lastMessage(spy);
      expect(output).toContain("count=42");
    });

    it("serializes boolean values with JSON.stringify", () => {
      setLogLevel("debug");
      logger.debug("flag", { enabled: true });

      const output = lastMessage(spy);
      expect(output).toContain("enabled=true");
    });

    it("serializes null values with JSON.stringify", () => {
      setLogLevel("debug");
      logger.debug("empty", { value: null });

      const output = lastMessage(spy);
      expect(output).toContain("value=null");
    });

    it("serializes object values as JSON", () => {
      setLogLevel("debug");
      logger.debug("nested", { data: { a: 1 } });

      const output = lastMessage(spy);
      expect(output).toContain('data={"a":1}');
    });

    it("separates multiple key=value pairs with spaces", () => {
      setLogLevel("debug");
      logger.debug("multi", { a: 1, b: 2 });

      const output = lastMessage(spy);
      // The pairs appear after the message, space-separated
      expect(output).toMatch(/multi a=1 b=2$/);
    });

    it("does not append anything when context is undefined", () => {
      setLogLevel("debug");
      logger.debug("bare message");

      const output = lastMessage(spy);
      // Should end with the message, no trailing space or pairs
      expect(output).toMatch(/bare message$/);
    });

    it("does not append anything when context is an empty object", () => {
      setLogLevel("debug");
      logger.debug("bare message", {});

      const output = lastMessage(spy);
      expect(output).toMatch(/bare message$/);
    });
  });
});
