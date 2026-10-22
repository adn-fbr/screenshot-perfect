import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, FolderOpen, Plus, Play, Square, Trash2, ScanSearch, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraTile, StatusBadge, type CameraRuntime, type SegmentInfo } from "@/components/vsr/CameraTile";
import {
  FRAME_RATES,
  RESOLUTIONS,
  bitrateFor,
  canRemoveCamera,
  estimateBytes,
  findDuplicateDevices,
  formatBytes,
  formatDuration,
  makeCamera,
  makeDefaultCameras,
  type CameraConfig,
} from "@/lib/vsr/cameras";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VSR-CORE · Live Multi-Camera Monitor" },
      { name: "description", content: "Monitor and independently record 3+ USB cameras for grassroots football and futsal video review." },
      { property: "og:title", content: "VSR-CORE · Live Multi-Camera Monitor" },
      { property: "og:description", content: "Human-operated video support review: multi-camera monitoring and local recording." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Monitor,
});

const STORAGE_KEY = "vsr.cameras.v1";

function Monitor() {
  const [cams, setCams] = useState<CameraConfig[]>(() => makeDefaultCameras());
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permError, setPermError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [selected, setSelected] = useState("CAM-1");
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [runtime, setRuntime] = useState<Record<string, CameraRuntime>>({});
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [now, setNow] = useState(0);
  const [supportsFs, setSupportsFs] = useState(false);
  const streams = useRef<Record<string, MediaStream | null>>({});
  const bigRef = useRef<HTMLVideoElement>(null);
  const [streamTick, setStreamTick] = useState(0);

  // Load saved config (client only).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setCams(JSON.parse(saved));
    } catch {}
    setSupportsFs("showDirectoryPicker" in window);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cams));
  }, [cams]);

  const refreshDevices = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((d) => d.kind === "videoinput"));
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  useEffect(() => {
    const tick = () => navigator.storage?.estimate().then((e) => setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  async function requestAccess() {
    setPermError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      await refreshDevices();
      // Auto-assign distinct devices to empty slots.
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      setCams((cs) => {
        const used = new Set(cs.map((c) => c.deviceId).filter(Boolean));
        const free = list.filter((d) => !used.has(d.deviceId));
        return cs.map((c) => (c.deviceId && list.some((d) => d.deviceId === c.deviceId) ? c : { ...c, deviceId: free.shift()?.deviceId ?? null }));
      });
    } catch (e) {
      const err = e as Error;
      setPermError(`${err.name}: ${err.message}`);
    }
  }

  async function pickFolder() {
    try {
      const h = await (window as unknown as { showDirectoryPicker: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "readwrite" });
      setDir(h);
    } catch {}
  }

  const dups = useMemo(() => findDuplicateDevices(cams), [cams]);
  const patch = (id: string, p: Partial<CameraConfig>) => setCams((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  function startRecording() {
    const id = `VSR-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    setSegments([]);
    setSessionId(id);
    setRecStart(Date.now());
    setRecording(true);
  }

  async function stopRecording() {
    setRecording(false);
    const endedAt = new Date().toISOString();
    // Wait briefly for recorders to flush, then write the session manifest.
    setTimeout(async () => {
      setSegments((segs) => {
        const manifest = {
          sessionId,
          startedAt: recStart ? new Date(recStart).toISOString() : null,
          endedAt,
          clockNote: "Wall-clock times come from this PC. Cameras are not hardware-synced; offsets are not measured.",
          cameras: cams.map((c) => ({ ...c, actual: runtime[c.id]?.actual, measuredFps: runtime[c.id]?.measuredFps, reconnects: runtime[c.id]?.reconnects })),
          segments: segs,
        };
        const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
        const name = `${sessionId}_manifest.json`;
        if (dir) {
          dir.getFileHandle(name, { create: true }).then(async (h) => {
            const w = await h.createWritable();
            await w.write(blob);
            await w.close();
          });
        } else {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = name;
          a.click();
        }
        return segs;
      });
    }, 1500);
  }

  const onStream = useCallback((id: string, s: MediaStream | null) => {
    streams.current[id] = s;
    setStreamTick((t) => t + 1);
  }, []);
  const onRuntime = useCallback((id: string, r: CameraRuntime) => setRuntime((m) => ({ ...m, [id]: r })), []);
  const onSegment = useCallback((s: SegmentInfo) => setSegments((x) => [...x, s]), []);

  useEffect(() => {
    if (bigRef.current) {
      bigRef.current.srcObject = streams.current[selected] ?? null;
      bigRef.current.play().catch(() => {});
    }
  }, [selected, streamTick]);

  const connected = cams.filter((c) => runtime[c.id]?.status === "connected").length;
  const hourly = cams.reduce((sum, c) => sum + estimateBytes(bitrateFor(c.width, c.height, c.fps), 3600), 0);
  const sel = cams.find((c) => c.id === selected) ?? cams[0]!;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h1 className="font-mono text-lg font-bold tracking-tight">
            VSR-CORE <span className="text-primary">/</span> Live Monitor
          </h1>
          <p className="text-xs text-muted-foreground">Human-operated video support review · not certified VAR technology</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {connected}/{cams.length} connected · {devices.length} device(s) found
          </span>
          {!live ? (
            <Button onClick={() => setLive(true)} disabled={!cams.some((c) => c.deviceId)}>
              <Play className="h-4 w-4" /> Start capture
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => { if (recording) stopRecording(); setLive(false); }}>
              <Square className="h-4 w-4" /> Stop capture
            </Button>
          )}
          {!recording ? (
            <Button variant="destructive" onClick={startRecording} disabled={!live || connected === 0}>
              <Circle className="h-4 w-4 fill-current" /> Record all
            </Button>
          ) : (
            <Button variant="destructive" onClick={stopRecording}>
              <Square className="h-4 w-4" /> Stop · {recStart && now ? formatDuration(now - recStart) : "00:00:00"}
            </Button>
          )}
        </div>
      </header>

      {permError && <div className="border-b border-destructive bg-destructive/15 px-4 py-2 text-sm">Camera access failed — {permError}</div>}
      {devices.length > 0 && devices.every((d) => !d.label) && (
        <div className="border-b border-warning bg-warning/15 px-4 py-2 text-sm">Camera names are hidden until you allow camera access.</div>
      )}

      <main className="grid gap-4 p-4 xl:grid-cols-[1fr_340px]">
        <section className="space-y-4">
          <div className="border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="font-mono text-sm font-semibold">
                Program · {sel.id} {sel.name}
              </span>
              <StatusBadge status={runtime[sel.id]?.status ?? "idle"} />
            </div>
            <div className="aspect-video bg-feed">
              <video ref={bigRef} muted playsInline className="h-full w-full object-contain" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cams.map((c) => (
              <CameraTile
                key={c.id}
                config={c}
                live={live}
                recording={recording}
                sessionId={sessionId}
                dir={dir}
                duplicate={dups.includes(c.id)}
                selected={selected === c.id}
                onSelect={() => setSelected(c.id)}
                onStream={onStream}
                onRuntime={onRuntime}
                onSegment={onSegment}
              />
            ))}
          </div>
        </section>

        <aside className="space-y-4">
          <Panel title="Devices">
            <Button variant="secondary" className="w-full" onClick={requestAccess}>
              <ScanSearch className="h-4 w-4" /> Detect cameras
            </Button>
            <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
              {devices.map((d, i) => (
                <li key={d.deviceId || i} className="truncate">• {d.label || `Unnamed camera ${i + 1}`}</li>
              ))}
              {devices.length === 0 && <li>No cameras detected yet.</li>}
            </ul>
          </Panel>

          <Panel title="Camera configuration">
            <div className="space-y-3">
              {cams.map((c) => (
                <div key={c.id} className="space-y-1.5 border-b border-border pb-3 last:border-0">
                  <div className="flex items-center justify-between font-mono text-xs font-semibold">
                    {c.id}
                    {canRemoveCamera(cams.length) && (
                      <Button size="icon" variant="ghost" className="h-6 w-6" disabled={live} aria-label={`Remove ${c.id}`}
                        onClick={() => setCams((cs) => cs.filter((x) => x.id !== c.id))}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <input className="field" value={c.name} onChange={(e) => patch(c.id, { name: e.target.value })} aria-label="Name" />
                    <input className="field" value={c.role} onChange={(e) => patch(c.id, { role: e.target.value })} aria-label="Role" />
                  </div>
                  <select className="field w-full" value={c.deviceId ?? ""} disabled={live} aria-label="Device"
                    onChange={(e) => patch(c.id, { deviceId: e.target.value || null })}>
                    <option value="">— No device —</option>
                    {devices.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-1.5">
                    <select className="field" disabled={live} aria-label="Resolution" value={`${c.width}x${c.height}`}
                      onChange={(e) => { const r = RESOLUTIONS.find((x) => `${x.width}x${x.height}` === e.target.value)!; patch(c.id, { width: r.width, height: r.height }); }}>
                      {RESOLUTIONS.map((r) => <option key={r.label} value={`${r.width}x${r.height}`}>{r.label}</option>)}
                    </select>
                    <select className="field" disabled={live} aria-label="Frame rate" value={c.fps}
                      onChange={(e) => patch(c.id, { fps: Number(e.target.value) })}>
                      {FRAME_RATES.map((f) => <option key={f} value={f}>{f} fps</option>)}
                    </select>
                  </div>
                </div>
              ))}
              <Button variant="outline" className="w-full" disabled={live}
                onClick={() => setCams((cs) => [...cs, makeCamera(Math.max(...cs.map((c) => Number(c.id.split("-")[1]))))])}>
                <Plus className="h-4 w-4" /> Add camera
              </Button>
              {live && <p className="text-xs text-muted-foreground">Stop capture to change devices or settings.</p>}
            </div>
          </Panel>

          <Panel title="Recording storage">
            {supportsFs ? (
              <Button variant="secondary" className="w-full" onClick={pickFolder} disabled={recording}>
                <FolderOpen className="h-4 w-4" /> {dir ? `Folder: ${dir.name}` : "Choose save folder"}
              </Button>
            ) : (
              <p className="text-xs text-warning">This browser can't write to a folder. Files download when recording stops — use Chrome or Edge for direct-to-disk saving.</p>
            )}
            {supportsFs && !dir && <p className="mt-2 text-xs text-warning">No folder chosen: footage is held in memory and downloaded when you stop.</p>}
            <dl className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
              <div className="flex justify-between"><dt>Est. per hour (all cams)</dt><dd className="text-foreground">{formatBytes(hourly)}</dd></div>
              {quota && <div className="flex justify-between"><dt>Browser storage free</dt><dd>{formatBytes(quota.quota - quota.usage)}</dd></div>}
            </dl>
            <p className="mt-2 flex gap-1 text-[11px] text-muted-foreground">
              <HardDrive className="h-3 w-3 shrink-0" /> Browsers can't read real disk space. Check the drive holding your save folder has room.
            </p>
          </Panel>

          <Panel title={`Session log${sessionId ? ` · ${sessionId}` : ""}`}>
            {segments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No finished recording segments yet.</p>
            ) : (
              <ul className="space-y-1 font-mono text-[11px]">
                {segments.map((s) => (
                  <li key={s.file} className="border-b border-border pb-1">
                    <div className="truncate">{s.file}</div>
                    <div className="text-muted-foreground">{formatBytes(s.bytes)} · {s.endReason}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </main>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-card">
      <div className="truncate border-b border-border px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="p-3">{children}</div>
    </div>
  );
}
