import { useEffect, useRef, useState } from "react";
import { Circle, Maximize2, RefreshCw, VideoOff, AlertTriangle, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  bitrateFor,
  formatBytes,
  type ActualSettings,
  type CameraConfig,
  type CameraStatus,
} from "@/lib/vsr/cameras";

export interface SegmentInfo {
  cameraId: string;
  segment: number;
  file: string;
  startedAt: string;
  endedAt?: string;
  bytes: number;
  endReason?: string;
}

export interface CameraRuntime {
  status: CameraStatus;
  error?: string;
  actual: ActualSettings;
  measuredFps: number | null;
  lastFrameAt: number | null;
  reconnects: number;
}

interface Props {
  config: CameraConfig;
  live: boolean; // capture session running
  recording: boolean;
  sessionId: string | null;
  dir: FileSystemDirectoryHandle | null;
  duplicate: boolean;
  selected: boolean;
  onSelect: () => void;
  onStream: (id: string, s: MediaStream | null) => void;
  onRuntime: (id: string, r: CameraRuntime) => void;
  onSegment: (s: SegmentInfo) => void;
}

function pickMime() {
  const opts = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return opts.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

export function CameraTile(p: Props) {
  const { config } = p;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [rt, setRt] = useState<CameraRuntime>({
    status: "idle",
    actual: {},
    measuredFps: null,
    lastFrameAt: null,
    reconnects: 0,
  });
  const [retryTick, setRetryTick] = useState(0);
  const [now, setNow] = useState(0);
  const [recBytes, setRecBytes] = useState(0);
  const segRef = useRef(0);
  const cbRef = useRef(p);
  cbRef.current = p;

  const lastFrameRef = useRef<number | null>(null);
  const update = (patch: Partial<CameraRuntime>) => setRt((r) => ({ ...r, ...patch }));
  useEffect(() => {
    cbRef.current.onRuntime(config.id, rt);
  }, [config.id, rt.status, rt.actual, rt.measuredFps, rt.reconnects, rt.error]);

  // Open / close the physical device.
  useEffect(() => {
    if (!p.live || !config.deviceId) {
      update({ status: "idle", error: undefined });
      return;
    }
    let cancelled = false;
    let s: MediaStream | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    update({ status: "connecting", error: undefined });
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: config.deviceId },
          width: { ideal: config.width },
          height: { ideal: config.height },
          frameRate: { ideal: config.fps },
        },
      })
      .then((ms) => {
        if (cancelled) return ms.getTracks().forEach((t) => t.stop());
        s = ms;
        const track = ms.getVideoTracks()[0];
        const st = track.getSettings();
        track.addEventListener("ended", () => {
          if (cancelled) return;
          update({ status: "disconnected", error: "Device stopped sending video (unplugged or in use)." });
          setStream(null);
          cbRef.current.onStream(config.id, null);
          retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 3000);
        });
        setStream(ms);
        cbRef.current.onStream(config.id, ms);
        update({
          status: "connected",
          actual: { width: st.width, height: st.height, frameRate: st.frameRate, label: track.label },
        });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        const disconnected = e.name === "NotFoundError" || e.name === "OverconstrainedError";
        update({ status: disconnected ? "disconnected" : "error", error: `${e.name}: ${e.message}` });
        retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 4000);
      });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      s?.getTracks().forEach((t) => t.stop());
      setStream(null);
      cbRef.current.onStream(config.id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.live, config.deviceId, config.width, config.height, config.fps, retryTick]);

  useEffect(() => {
    if (retryTick > 0) update({ reconnects: rt.reconnects + 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTick]);

  // Attach stream + measure real decoded frames.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (!stream) return;
    v.play().catch(() => {});
    let handle = 0;
    let frames = 0;
    let windowStart = performance.now();
    const hasRvfc = "requestVideoFrameCallback" in v;
    const onFrame = () => {
      frames++;
      lastFrameRef.current = Date.now();
      const t = performance.now();
      if (t - windowStart >= 1000) {
        update({ measuredFps: (frames * 1000) / (t - windowStart), lastFrameAt: Date.now() });
        frames = 0;
        windowStart = t;
      }
      if (hasRvfc) handle = v.requestVideoFrameCallback(onFrame);
    };
    if (hasRvfc) handle = v.requestVideoFrameCallback(onFrame);
    return () => {
      if (hasRvfc) v.cancelVideoFrameCallback(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Independent per-camera recording. A new segment starts after every reconnect.
  useEffect(() => {
    if (!p.recording || !stream || !p.sessionId) return;
    const mime = pickMime();
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    segRef.current += 1;
    const seg = segRef.current;
    const file = `${p.sessionId}_${config.id}_seg${String(seg).padStart(3, "0")}.${ext}`;
    const info: SegmentInfo = { cameraId: config.id, segment: seg, file, startedAt: new Date().toISOString(), bytes: 0 };
    const chunks: Blob[] = [];
    let writable: FileSystemWritableFileStream | null = null;
    let writeChain: Promise<unknown> = Promise.resolve();
    const dir = p.dir;
    if (dir) {
      writeChain = dir
        .getFileHandle(file, { create: true })
        .then((h) => h.createWritable())
        .then((w) => (writable = w))
        .catch((e) => update({ error: `Cannot write to folder: ${e.message}` }));
    }
    const rec = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: bitrateFor(config.width, config.height, config.fps),
    });
    let endReason = "stopped by operator";
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      info.bytes += e.data.size;
      setRecBytes((b) => b + e.data.size);
      if (dir) writeChain = writeChain.then(() => writable?.write(e.data));
      else chunks.push(e.data);
    };
    rec.onerror = () => (endReason = "recorder error");
    rec.onstop = () => {
      info.endedAt = new Date().toISOString();
      info.endReason = endReason;
      writeChain = writeChain.then(async () => {
        if (writable) await writable.close();
        else if (!dir && chunks.length) {
          const url = URL.createObjectURL(new Blob(chunks, { type: mime || "video/webm" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = file;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        }
        cbRef.current.onSegment(info);
      });
    };
    const track = stream.getVideoTracks()[0];
    const onEnded = () => (endReason = "camera disconnected");
    track.addEventListener("ended", onEnded);
    rec.start(1000);
    return () => {
      track.removeEventListener("ended", onEnded);
      if (rec.state !== "inactive") rec.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.recording, stream, p.sessionId]);

  useEffect(() => {
    if (!p.recording) setRecBytes(0);
  }, [p.recording]);

  const frameAge = lastFrameRef.current && now ? Math.max(0, now - lastFrameRef.current) / 1000 : null;
  const stalled = rt.status === "connected" && frameAge !== null && frameAge > 2;
  const isRec = p.recording && !!stream;

  return (
    <div
      className={`flex flex-col border bg-card ${p.selected ? "border-primary" : "border-border"}`}
      aria-label={`${config.name} tile`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold">
            {config.id} · {config.name}
          </div>
          <div className="truncate text-xs text-muted-foreground">{config.role}</div>
        </div>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={p.onSelect} aria-label="Show large">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative aspect-video bg-feed">
        <video ref={videoRef} muted playsInline className="h-full w-full object-contain" />
        {!stream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
            <VideoOff className="h-6 w-6" />
            <span className="text-xs">
              {!config.deviceId ? "No device assigned" : !p.live ? "Capture not started" : "No signal"}
            </span>
          </div>
        )}
        {isRec && (
          <div className="absolute left-2 top-2 flex items-center gap-1 bg-recording px-1.5 py-0.5 font-mono text-[10px] font-bold text-recording-foreground">
            <Circle className="rec-dot h-2 w-2 fill-current" /> REC
          </div>
        )}
      </div>
      <div className="space-y-1 px-2 py-1.5 text-xs">
        <StatusBadge status={rt.status} stalled={stalled} />
        {p.duplicate && (
          <div className="flex items-center gap-1 text-warning">
            <AlertTriangle className="h-3 w-3" /> Same device as another slot
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-2 font-mono text-[11px] text-muted-foreground">
          <dt>Requested</dt>
          <dd className="text-right">
            {config.width}×{config.height} @{config.fps}
          </dd>
          <dt>Actual</dt>
          <dd className="text-right text-foreground">
            {rt.actual.width ? `${rt.actual.width}×${rt.actual.height} @${rt.actual.frameRate?.toFixed(0) ?? "?"}` : "—"}
          </dd>
          <dt>Measured fps</dt>
          <dd className="text-right text-foreground">{stream && rt.measuredFps ? rt.measuredFps.toFixed(1) : "—"}</dd>
          <dt>Last frame</dt>
          <dd className="text-right">{stream && frameAge !== null ? `${frameAge.toFixed(0)}s ago` : "—"}</dd>
          <dt>Recording</dt>
          <dd className="text-right">{isRec ? formatBytes(recBytes) : "Not recording"}</dd>
          <dt>Reconnects</dt>
          <dd className="text-right">{rt.reconnects}</dd>
        </dl>
        {rt.error && <p className="text-destructive">{rt.error}</p>}
        {(rt.status === "disconnected" || rt.status === "error") && (
          <Button size="sm" variant="secondary" className="h-7 w-full" onClick={() => setRetryTick((t) => t + 1)}>
            <RefreshCw className="h-3 w-3" /> Retry now
          </Button>
        )}
      </div>
    </div>
  );
}

export function StatusBadge({ status, stalled }: { status: CameraStatus; stalled?: boolean }) {
  const map: Record<CameraStatus, { label: string; cls: string }> = {
    idle: { label: "Idle", cls: "bg-muted text-muted-foreground" },
    connecting: { label: "Connecting…", cls: "bg-secondary text-secondary-foreground" },
    connected: { label: "Connected", cls: "bg-success text-success-foreground" },
    disconnected: { label: "Disconnected", cls: "bg-destructive text-destructive-foreground" },
    error: { label: "Error", cls: "bg-destructive text-destructive-foreground" },
  };
  const m = stalled ? { label: "Connected · no frames", cls: "bg-warning text-warning-foreground" } : map[status];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[11px] font-semibold ${m.cls}`}>
      <Wifi className="h-3 w-3" />
      {m.label}
    </span>
  );
}
