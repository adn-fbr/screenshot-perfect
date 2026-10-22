import { describe, expect, it } from "vitest";
import { canRemoveCamera, findDuplicateDevices, makeDefaultCameras, estimateBytes } from "./cameras";

describe("camera rules", () => {
  it("starts with at least 3 camera slots", () => {
    expect(makeDefaultCameras().length).toBe(3);
    expect(makeDefaultCameras(1).length).toBe(3);
    expect(makeDefaultCameras(5).length).toBe(5);
  });

  it("never allows dropping below 3 cameras", () => {
    expect(canRemoveCamera(3)).toBe(false);
    expect(canRemoveCamera(4)).toBe(true);
  });

  it("flags two slots using the same physical device (no fake multi-camera)", () => {
    const dups = findDuplicateDevices([
      { id: "CAM-1", deviceId: "a" },
      { id: "CAM-2", deviceId: "a" },
      { id: "CAM-3", deviceId: "b" },
      { id: "CAM-4", deviceId: null },
    ]);
    expect(dups.sort()).toEqual(["CAM-1", "CAM-2"]);
  });

  it("estimates storage from bitrate", () => {
    expect(estimateBytes(8_000_000, 60)).toBe(60_000_000);
  });
});
