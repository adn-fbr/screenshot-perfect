// Pure helpers for camera slots — browser-safe, no side effects at import time.

export const MIN_CAMERAS = 3;

export type CameraStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export interface CameraConfig {
  id: string; // stable slot id, e.g. CAM-1
  name: string;
  role: string;
  deviceId: string | null;
  width: number;
  height: number;
  fps: number;
}

export interface ActualSettings {
  width?: number;
  height?: number;
  frameRate?: number;
  label?: string;
}

export const RESOLUTIONS = [
  { label: "480p", width: 854, height: 480 },
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
];
export const FRAME_RATES = [15, 24, 30, 60];

const DEFAULT_ROLES = ["Main wide", "Left / goal area", "Right / opposite"];

export function makeDefaultCameras(count = MIN_CAMERAS): CameraConfig[] {
  return Array.from({ length: Math.max(count, MIN_CAMERAS) }, (_, i) => makeCamera(i));
}

export function makeCamera(index: number): CameraConfig {
  return {
    id: `CAM-${index + 1}`,
    name: `Camera ${index + 1}`,
    role: DEFAULT_ROLES[index] ?? "Additional",
    deviceId: null,
    width: 1280,
    height: 720,
    fps: 30,
  };
}

/** Returns ids of slots that point at the same physical device as another slot. */
export function findDuplicateDevices(cams: Pick<CameraConfig, "id" | "deviceId">[]): string[] {
  const seen = new Map<string, string[]>();
  for (const c of cams) {
    if (!c.deviceId) continue;
    seen.set(c.deviceId, [...(seen.get(c.deviceId) ?? []), c.id]);
  }
  return [...seen.values()].filter((ids) => ids.length > 1).flat();
}

export function canRemoveCamera(count: number) {
  return count > MIN_CAMERAS;
}

/** Rough storage estimate in bytes for a recording at a given bitrate. */
export function estimateBytes(bitsPerSecond: number, seconds: number) {
  return Math.round((bitsPerSecond / 8) * seconds);
}

export function bitrateFor(width: number, height: number, fps: number) {
  // ~0.1 bits per pixel per frame — reasonable WebM/VP8-9 target for webcams.
  return Math.round(width * height * fps * 0.1);
}

export function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    b /= 1024;
    i++;
  } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(1)} ${u[i]}`;
}

export function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}
