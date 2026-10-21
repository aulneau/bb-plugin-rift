import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupportedPlatform, standardRegistry } from "../platform.js";

test("macOS and Linux x64 are supported; others are refused", () => {
  assert.equal(isSupportedPlatform("darwin-arm64"), true);
  assert.equal(isSupportedPlatform("darwin-x64"), true);
  assert.equal(isSupportedPlatform("linux-x64"), true);
  assert.equal(isSupportedPlatform("linux-arm64"), false);
  assert.equal(isSupportedPlatform("win32-x64"), false);
});

test("standard registry follows Rift's data_local_dir", () => {
  assert.equal(
    standardRegistry("darwin", "/Users/a", {}),
    "/Users/a/Library/Application Support/rift/rift.sqlite",
  );
  assert.equal(
    standardRegistry("linux", "/home/a", {}),
    "/home/a/.local/share/rift/rift.sqlite",
  );
  assert.equal(
    standardRegistry("linux", "/home/a", { XDG_DATA_HOME: "/data" }),
    "/data/rift/rift.sqlite",
  );
  assert.equal(
    standardRegistry("linux", "/home/a", { XDG_DATA_HOME: "relative" }),
    "/home/a/.local/share/rift/rift.sqlite",
  );
});
