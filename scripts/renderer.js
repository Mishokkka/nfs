import {
  pointAtTrackProgress,
  pointAtPitProgress,
  grassWidthForSide,
  runoffSurfaceForSide,
  boundaryPoint,
  wallBoundaryPoint,
  wallSegmentActiveRange
} from "./track.js";
import { applyDriveModel } from "./physics/drive-model.js";
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const angleDelta = (target, current) => Math.atan2(Math.sin(target - current), Math.cos(target - current));
const smoothingFactor = (dt, timeConstant) => 1 - Math.exp(-Math.max(0, dt) / Math.max(0.001, timeConstant));
const formatRaceTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}:${remaining.toFixed(2).padStart(5, "0")}`;
};
const CAMERA_MODES = new Set(["overview", "chase"]);
const MAX_STATIC_LAYER_SIZE = 2560;
const MAX_CANVAS_PIXELS = 3_200_000;
const MAX_OUTPUT_SCALE = 1.5;
const MAX_LABEL_CACHE = 32;
const TRACK_TILE_WORLD_SIZE = 640;
const TRACK_TILE_SCALE = 1.0;
const TRACK_TILE_BLEED = 72;
const TRACK_TILE_OVERLAP_PX = 1;
const MAX_TRACK_TILES = 16;
const MAX_NEW_TILES_PER_FRAME = 1;
const RAF_SAMPLE_LIMIT = 180;
const RENDER_SAMPLE_LIMIT = 120;
const DISPLAY_REFRESH_RATES = [60, 72, 75, 90, 100, 120, 144, 165, 180, 200, 240];
const DELIVERY_SAMPLE_LIMIT = 72;
const WALL_FADE_BUCKETS = 8;
const PLACE_ORDER_STABILITY_MS = 180;

export class RaceRenderer {
  constructor(canvas, track, {
    localCarId = null,
    onHud = null,
    cameraMode = "overview",
    minimapEnabled = true,
    enableLocalPrediction = true,
    networkRenderDelay = null,
    maxExtrapolation = null,
    performanceOverlay = false,
    smoothAuthoritativePresentation = false
  } = {}) {
    this.canvas = canvas;
    this.destroyed = false;
    this.resizeFrame = null;
    // desynchronized:true intentionally omitted. Chromium may present such canvases
    // outside the normal compositor cadence, which is useful for latency tests but
    // produces visible micro-jitter inside Foundry's animated window compositor.
    this.context = canvas.getContext("2d", { alpha: false });
    if (!this.context) throw new Error("Canvas 2D недоступен в текущем клиенте.");
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";

    this.track = track;
    this.localCarId = localCarId;
    this.onHud = onHud;
    this.cameraMode = CAMERA_MODES.has(cameraMode) ? cameraMode : "overview";
    this.minimapEnabled = Boolean(minimapEnabled);
    this.previousSnapshot = null;
    this.currentSnapshot = null;
    this.snapshotBuffer = [];
    this.simulationFrame = null;
    this.snapshotAt = performance.now();
    this.snapshotInterval = 50;
    // Map the authoritative simulation clock onto the local monotonic clock.
    // Anchoring presentation to the latest packet arrival made the target clock
    // jump backwards whenever one packet had more latency than the previous one.
    this.playbackSource = null;
    this.playbackClockOffset = null;
    this.playbackTargetTime = null;
    this.playbackTargetAt = 0;
    this.playbackOffsetSample = null;
    this.enableLocalPrediction = Boolean(enableLocalPrediction);
    this.networkRenderDelay = Number.isFinite(Number(networkRenderDelay)) ? clamp(Number(networkRenderDelay), 0, 0.5) : 0.11;
    this.maxExtrapolation = Number.isFinite(Number(maxExtrapolation)) ? clamp(Number(maxExtrapolation), 0.02, 0.6) : 0.34;
    this.smoothAuthoritativePresentation = Boolean(smoothAuthoritativePresentation);
    this.lastDrawAt = performance.now();
    this.lastRenderedAt = 0;
    this.lastRafAt = 0;
    this.renderTargetFps = 60;
    this.displayRefreshHz = 60;
    this.displayRefreshInterval = 1000 / 60;
    this.renderDivisor = 1;
    this.renderPhase = 0;
    this.effectiveTargetFps = 60;
    this.rafIntervals = [];
    this.renderIntervals = [];
    this.renderCosts = [];
    this.renderIntervalP50 = 0;
    this.renderIntervalP95 = 0;
    this.renderIntervalMax = 0;
    this.renderCostP95 = 0;
    this.renderCostMax = 0;
    this.rafP50 = 0;
    this.rafP95 = 0;
    this.rafMax = 0;
    this.rafLong25 = 0;
    this.rafLong40 = 0;
    this.rafLong80 = 0;
    this.longTaskObserver = null;
    this.longTaskDurations = [];
    this.longTaskCount = 0;
    this.longTaskP95 = 0;
    this.longTaskMax = 0;
    this.lastTimingStatsAt = 0;
    this.lastDisplayCadenceAt = 0;
    this.deliverySource = "none";
    this.deliveryIntervals = [];
    this.deliveryMs = 0;
    this.deliveryP95 = 0;
    this.deliveryMax = 0;
    this.deliveryStatsDirty = false;
    this.frameCostEma = 0;
    this.frameOverBudgetCount = 0;
    this.frameUnderBudgetCount = 0;
    this.renderedFrames = 0;
    this.cameraRawDtMs = 0;
    this.cameraStepMs = 0;
    this.fpsWindowStartedAt = performance.now();
    this.measuredFps = 0;
    this.outputScale = 1;
    this.labelCache = new Map();
    this.labelCacheHits = 0;
    this.labelCacheMisses = 0;
    this.presentationCars = new Map();
    this.activePresentationIds = new Set();
    this.blendedSnapshot = {};
    this.blendedCars = [];
    this.smoothedSnapshot = {};
    this.smoothedCars = [];
    this.presentationOrder = null;
    this.presentationOrderSignature = "";
    this.presentationOrderCandidate = null;
    this.presentationOrderCandidateOrder = null;
    this.presentationOrderCandidateSince = 0;
    this.presentationFinishCount = 0;
    this.presentationOrderSourceTick = null;
    this.presentationPlaceById = new Map();
    this.localInput = { throttle: 0, steer: 0, brake: false, reverse: false, boost: false, ram: false, drift: false };
    this.localInputSequence = 0;
    this.predictionState = null;
    this.predictionBlocked = false;
    this.predictionClearSince = 0;
    this.predictionError = 0;
    this.predictionCorrection = 0;
    this.trackTiles = new Map();
    this.trackTileUseCounter = 0;
    this.trackTileCoverage = new Set();
    this.trackTileHits = 0;
    this.trackTileMisses = 0;
    this.trackTileGenerated = 0;
    this.trackTileAllocations = 0;
    this.trackTileReuses = 0;
    this.trackTileEvictions = 0;
    this.trackTileGenerationTimes = [];
    this.trackTileGenerationRate = 0;
    this.trackVisibleTiles = 0;
    this.trackTileFallbacks = 0;
    this.visibleTrackEntries = [];
    this.retainedTrackTileKeys = new Set();
    this.visibleTrackTileBounds = { minTileX: 0, maxTileX: 0, minTileY: 0, maxTileY: 0 };
    this.trackRenderMode = "bitmap";
    this.performanceOverlay = Boolean(performanceOverlay);
    try {
      if (typeof globalThis.PerformanceObserver === "function") {
        this.longTaskObserver = new globalThis.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const duration = Number(entry.duration);
            if (!Number.isFinite(duration) || duration < 25) continue;
            this.longTaskDurations.push(duration);
            this.longTaskCount += 1;
            if (this.longTaskDurations.length > 72) this.longTaskDurations.shift();
          }
        });
        this.longTaskObserver.observe({ type: "longtask", buffered: false });
      }
    } catch (_) {
      this.longTaskObserver = null;
    }

    const startHeading = Math.atan2(track.start.ty, track.start.tx);
    this.camera = {
      x: track.start.x,
      y: track.start.y,
      zoom: 0.72,
      rotation: this.cameraMode === "chase" ? -Math.PI / 2 - startHeading : 0,
      heading: startHeading,
      speed: 0,
      initialized: false
    };

    this.trackPath = this.#buildTrackPath(this.track.samples, true);
    this.pitPath = this.#buildTrackPath(this.track.pit?.samples ?? [], false);
    this.runoffSurfacePaths = this.#buildRunoffSurfacePaths(this.track.samples, this.track.width, true);
    this.pitRunoffSurfacePaths = this.#buildRunoffSurfacePaths(this.track.pit?.samples ?? [], this.track.pit?.width ?? 0, false, "grass");
    this.runoffTextureGeometry = this.#buildRunoffTextureGeometry(this.track.samples, this.track.width);
    this.wallGeometry = [
      this.#buildBoundaryWallGeometry(this.track.samples, this.track.width, 1, true, "wallLeftAlpha"),
      this.#buildBoundaryWallGeometry(this.track.samples, this.track.width, -1, true, "wallRightAlpha"),
      this.#buildBoundaryWallGeometry(this.track.pit?.samples ?? [], this.track.pit?.width ?? 0, -1, false, "wallRightAlpha"),
      this.#buildBoundaryWallGeometry(this.track.pit?.samples ?? [], this.track.pit?.width ?? 0, 1, false, "wallLeftAlpha")
    ];
    this.trackTileCoverage = this.#buildTrackTileCoverage();
    this.trackLayer = document.createElement("canvas");
    this.trackLayerContext = this.trackLayer.getContext("2d", { alpha: true });
    this.trackLayerMeta = null;
    this.minimapLayer = document.createElement("canvas");
    this.minimapLayerContext = this.minimapLayer.getContext("2d", { alpha: true });
    this.minimapProjection = null;
    this.background = document.createElement("canvas");
    this.backgroundContext = this.background.getContext("2d", { alpha: false });
    this.#rebuildTrackLayer();
    this.resizePending = false;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed || this.resizePending) return;
      this.resizePending = true;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = null;
        this.resizePending = false;
        if (!this.destroyed) this.resize();
      });
    });
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  setLocalCarId(id) {
    const next = id == null ? null : String(id);
    if (next === this.localCarId) return;
    this.localCarId = next;
    this.predictionState = null;
    this.predictionBlocked = false;
    this.predictionClearSince = 0;
  }

  setLocalInput(input, sequence = 0) {
    this.localInput = {
      throttle: clamp(Number(input?.throttle) || 0, -1, 1),
      steer: clamp(Number(input?.steer) || 0, -1, 1),
      brake: Boolean(input?.brake),
      reverse: Boolean(input?.reverse),
      boost: Boolean(input?.boost),
      ram: Boolean(input?.ram),
      drift: Boolean(input?.drift)
    };
    this.localInputSequence = Math.max(this.localInputSequence, Math.floor(Number(sequence) || 0));
  }

  setCameraMode(mode) {
    if (!CAMERA_MODES.has(mode) || mode === this.cameraMode) return;
    this.cameraMode = mode;
  }

  setMinimapEnabled(enabled) {
    this.minimapEnabled = Boolean(enabled);
  }

  getPerformanceStats() {
    const labelRequests = this.labelCacheHits + this.labelCacheMisses;
    const tileRequests = this.trackTileHits + this.trackTileMisses;
    return {
      fps: this.measuredFps,
      targetFps: this.renderTargetFps,
      effectiveTargetFps: this.effectiveTargetFps,
      displayRefreshHz: this.displayRefreshHz,
      renderDivisor: this.renderDivisor,
      renderMs: this.frameCostEma,
      renderP95: this.renderCostP95,
      renderMax: this.renderCostMax,
      renderIntervalP50: this.renderIntervalP50,
      renderIntervalP95: this.renderIntervalP95,
      renderIntervalMax: this.renderIntervalMax,
      rafP50: this.rafP50,
      rafP95: this.rafP95,
      rafMax: this.rafMax,
      rafLong25: this.rafLong25,
      rafLong40: this.rafLong40,
      rafLong80: this.rafLong80,
      rafSampleCount: this.rafIntervals.length,
      longTaskCount: this.longTaskCount,
      longTaskP95: this.longTaskP95,
      longTaskMax: this.longTaskMax,
      snapshotMs: this.snapshotInterval,
      playbackClockOffsetMs: Number.isFinite(this.playbackClockOffset) ? this.playbackClockOffset * 1000 : 0,
      playbackOffsetSampleMs: Number.isFinite(this.playbackOffsetSample) ? this.playbackOffsetSample * 1000 : 0,
      playbackTargetTime: Number.isFinite(this.playbackTargetTime) ? this.playbackTargetTime : 0,
      deliverySource: this.deliverySource,
      deliveryMs: this.deliveryMs,
      deliveryP95: this.deliveryP95,
      deliveryMax: this.deliveryMax,
      predictionError: this.predictionError,
      predictionCorrection: this.predictionCorrection,
      predictionBlocked: this.predictionBlocked,
      labelCacheSize: this.labelCache.size,
      labelCacheHits: this.labelCacheHits,
      labelCacheMisses: this.labelCacheMisses,
      labelCacheHitRate: labelRequests ? this.labelCacheHits / labelRequests : 1,
      trackRenderMode: this.trackRenderMode,
      trackTileCacheSize: this.trackTiles.size,
      trackTileHits: this.trackTileHits,
      trackTileMisses: this.trackTileMisses,
      trackTileHitRate: tileRequests ? this.trackTileHits / tileRequests : 1,
      trackTileGenerated: this.trackTileGenerated,
      trackTileAllocations: this.trackTileAllocations,
      trackTileReuses: this.trackTileReuses,
      trackTileEvictions: this.trackTileEvictions,
      trackTileGenerationRate: this.trackTileGenerationRate,
      trackVisibleTiles: this.trackVisibleTiles,
      trackTileFallbacks: this.trackTileFallbacks,
      cameraRawDtMs: this.cameraRawDtMs,
      cameraStepMs: this.cameraStepMs,
      authoritativeSmoothing: this.smoothAuthoritativePresentation
    };
  }

  recordSnapshotDelivery(intervalMs, source = "network") {
    const interval = Number(intervalMs);
    if (!Number.isFinite(interval) || interval <= 0 || interval > 2000) return;
    this.deliverySource = String(source || "network");
    this.deliveryMs = this.deliveryMs ? this.deliveryMs * 0.82 + interval * 0.18 : interval;
    this.deliveryIntervals.push(interval);
    if (this.deliveryIntervals.length > DELIVERY_SAMPLE_LIMIT) {
      this.deliveryIntervals.splice(0, this.deliveryIntervals.length - DELIVERY_SAMPLE_LIMIT);
    }
    // Percentiles are diagnostic only. Re-sorting this window for every 20-30 Hz
    // worker message creates avoidable allocation pressure in the main thread.
    this.deliveryStatsDirty = true;
  }

  getDiagnosticReport() {
    const rect = this.canvas?.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    return {
      stats: this.getPerformanceStats(),
      canvas: {
        cssWidth: Number(rect.width) || 0,
        cssHeight: Number(rect.height) || 0,
        backingWidth: Number(this.canvas?.width) || 0,
        backingHeight: Number(this.canvas?.height) || 0,
        outputScale: this.outputScale
      },
      camera: {
        mode: this.cameraMode,
        zoom: this.camera.zoom,
        rotation: this.camera.rotation
      },
      recentRafMs: this.rafIntervals.slice(-60).map((value) => Number(value.toFixed(2))),
      recentRenderIntervalsMs: this.renderIntervals.slice(-60).map((value) => Number(value.toFixed(2))),
      recentRenderCostsMs: this.renderCosts.slice(-60).map((value) => Number(value.toFixed(3))),
      recentDeliveryMs: this.deliveryIntervals.slice(-36).map((value) => Number(value.toFixed(2))),
      recentLongTasksMs: this.longTaskDurations.slice(-24).map((value) => Number(value.toFixed(2)))
    };
  }

  /**
   * Точные состояния локальной авторитетной симуляции. Коэффициент интерполяции
   * берётся из аккумулятора физики, поэтому кадры остаются плавными даже когда
   * между двумя отрисовками прошло ноль или сразу два физических шага.
   */
  setSimulationFrame(previous, current, alpha = 0) {
    if (this.destroyed || !current) return;
    const previousClock = this.#snapshotClock(previous ?? current);
    const currentClock = this.#snapshotClock(current);
    if (Number.isFinite(previousClock) && Number.isFinite(currentClock) && currentClock > previousClock) {
      this.snapshotInterval = clamp((currentClock - previousClock) * 1000, 1, 1000);
    }
    this.simulationFrame = {
      previous: previous ?? current,
      current,
      alpha: clamp(Number(alpha) || 0, 0, 1)
    };
  }

  /** Buffered snapshots for remote clients and the local simulation worker. */
  pushSnapshot(snapshot, { source = "network", generatedAt = null } = {}) {
    if (this.destroyed || !snapshot) return;
    this.simulationFrame = null;
    const now = performance.now();
    const clock = this.#snapshotClock(snapshot);
    if (!Number.isFinite(clock)) return;
    const last = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    if (last && (Number(snapshot.tick) <= Number(last.snapshot.tick) || clock < last.time)) return;
    if (this.currentSnapshot) {
      this.previousSnapshot = this.currentSnapshot;
      const simulationSpanMs = last ? (clock - last.time) * 1000 : NaN;
      this.snapshotInterval = Number.isFinite(simulationSpanMs) && simulationSpanMs > 0
        ? clamp(simulationSpanMs, 1, 1000)
        : clamp(now - this.snapshotAt, 1, 1000);
      this.recordSnapshotDelivery(clamp(now - this.snapshotAt, 1, 1000), source);
    }
    this.currentSnapshot = snapshot;
    this.snapshotAt = now;
    const generatedEpoch = Number(generatedAt);
    const generatedMainTime = Number.isFinite(generatedEpoch)
      ? generatedEpoch - Number(performance.timeOrigin || 0)
      : now;
    const presentationAt = Number.isFinite(generatedMainTime) && Math.abs(generatedMainTime - now) < 5000
      ? generatedMainTime
      : now;
    const sourceName = String(source || "network");
    if (sourceName !== this.playbackSource) {
      this.playbackSource = sourceName;
      this.playbackClockOffset = null;
      this.playbackTargetTime = null;
      this.playbackTargetAt = 0;
      this.playbackOffsetSample = null;
    }
    const offsetSample = presentationAt / 1000 - clock;
    if (Number.isFinite(offsetSample)) {
      this.playbackOffsetSample = offsetSample;
      // Packet latency can only increase this sample. Retaining the lowest
      // observed value estimates the stable clock offset without letting a late
      // packet rewind the scene. Worker production timestamps use the same path.
      if (!Number.isFinite(this.playbackClockOffset) || offsetSample < this.playbackClockOffset) {
        this.playbackClockOffset = offsetSample;
      }
    }
    this.snapshotBuffer.push({ snapshot, receivedAt: now, presentationAt, time: clock, source: sourceName });
    if (this.snapshotBuffer.length > 36) this.snapshotBuffer.splice(0, this.snapshotBuffer.length - 36);
  }

  #snapshotClock(snapshot) {
    const simulationTime = Number(snapshot?.simulationTime);
    if (Number.isFinite(simulationTime)) return simulationTime;
    return Number(snapshot?.time);
  }

  /**
   * Рендер вызывается тем же requestAnimationFrame, который двигает симуляцию.
   * Один общий цикл исключает гонку двух независимых RAF и чередование старого
   * и нового интерполяционного коэффициента между соседними кадрами.
   */
  render(now = performance.now()) {
    if (this.destroyed) return;
    this.#recordRaf(now);
    if (!this.#shouldRenderThisRaf(now)) return;

    if (this.lastRenderedAt > 0) {
      const interval = now - this.lastRenderedAt;
      if (Number.isFinite(interval) && interval > 0 && interval < 2000) {
        this.renderIntervals.push(interval);
        if (this.renderIntervals.length > RENDER_SAMPLE_LIMIT) {
          this.renderIntervals.splice(0, this.renderIntervals.length - RENDER_SAMPLE_LIMIT);
        }
      }
    }
    this.lastRenderedAt = now;

    const startedAt = performance.now();
    this.#draw(now);
    const cost = Math.max(0, performance.now() - startedAt);
    this.renderCosts.push(cost);
    if (this.renderCosts.length > RENDER_SAMPLE_LIMIT) {
      this.renderCosts.splice(0, this.renderCosts.length - RENDER_SAMPLE_LIMIT);
    }
    this.frameCostEma = this.frameCostEma ? this.frameCostEma * 0.92 + cost * 0.08 : cost;
    this.renderedFrames += 1;
    const fpsElapsed = now - this.fpsWindowStartedAt;
    if (fpsElapsed >= 500) {
      this.measuredFps = this.renderedFrames * 1000 / Math.max(1, fpsElapsed);
      this.renderedFrames = 0;
      this.fpsWindowStartedAt = now;
    }

    // Only use stable display divisors. Switch down solely when drawing itself
    // is persistently expensive; compositor or recorder stalls are now exposed by
    // RAF p95/max instead of being mistaken for Canvas workload.
    if (this.renderTargetFps === 60) {
      this.frameOverBudgetCount = this.frameCostEma > 24 ? this.frameOverBudgetCount + 1 : Math.max(0, this.frameOverBudgetCount - 2);
      if (this.frameOverBudgetCount >= 24) {
        this.renderTargetFps = 30;
        this.frameOverBudgetCount = 0;
        this.frameUnderBudgetCount = 0;
      }
    } else {
      this.frameUnderBudgetCount = this.frameCostEma < 12 ? this.frameUnderBudgetCount + 1 : 0;
      if (this.frameUnderBudgetCount >= 120) {
        this.renderTargetFps = 60;
        this.frameUnderBudgetCount = 0;
      }
    }
  }

  #chooseRenderDivisor(refreshHz, targetFps) {
    const hz = clamp(Number(refreshHz) || 60, 30, 360);
    const target = clamp(Number(targetFps) || 60, 24, 90);
    let bestDivisor = 1;
    let bestScore = Infinity;
    for (let divisor = 1; divisor <= 8; divisor += 1) {
      const rate = hz / divisor;
      const minimum = target >= 50 ? 45 : 24;
      const maximum = target >= 50 ? Math.max(61, target + 1) : 40;
      if (rate < minimum || rate > maximum) continue;
      // Prefer a stable divisor at or below the requested rate. On a 144 Hz
      // display both 72 and 48 are equally distant from 60, but 72 saturated
      // Electron's compositor and produced periodic 27-42 ms presentation gaps.
      const overshootPenalty = rate > target ? (rate - target) * 0.35 + 0.5 : 0;
      const score = Math.abs(rate - target) + overshootPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestDivisor = divisor;
      }
    }
    if (!Number.isFinite(bestScore)) bestDivisor = Math.max(1, Math.round(hz / target));
    return bestDivisor;
  }

  #updateDisplayCadence() {
    const candidates = [];
    for (const value of this.rafIntervals) {
      if (value >= 3 && value <= 25) candidates.push(value);
    }
    candidates.sort((a, b) => a - b);
    if (candidates.length < 6) return;
    const baseInterval = this.#percentile(candidates, 0.15);
    if (!Number.isFinite(baseInterval) || baseInterval <= 0) return;
    const rawHz = 1000 / baseInterval;
    let refreshHz = rawHz;
    let closestDelta = Infinity;
    for (const known of DISPLAY_REFRESH_RATES) {
      const delta = Math.abs(known - rawHz);
      if (delta < closestDelta) {
        closestDelta = delta;
        refreshHz = known;
      }
    }
    if (closestDelta > rawHz * 0.08) refreshHz = rawHz;
    this.displayRefreshHz = refreshHz;
    this.displayRefreshInterval = 1000 / Math.max(1, this.displayRefreshHz);
    const nextDivisor = this.#chooseRenderDivisor(this.displayRefreshHz, this.renderTargetFps);
    if (nextDivisor !== this.renderDivisor) {
      this.renderDivisor = nextDivisor;
      this.renderPhase = 0;
    }
    this.effectiveTargetFps = this.displayRefreshHz / Math.max(1, this.renderDivisor);
  }

  #shouldRenderThisRaf(now) {
    if (!this.lastRenderedAt) return true;
    const expectedInterval = 1000 / Math.max(1, this.effectiveTargetFps || this.renderTargetFps);
    if (now - this.lastRenderedAt >= expectedInterval * 1.6) {
      this.renderPhase = 0;
      return true;
    }
    this.renderPhase += 1;
    if (this.renderPhase < this.renderDivisor) return false;
    this.renderPhase = 0;
    return true;
  }

  #percentile(sorted, ratio) {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index];
  }

  #recordRaf(now) {
    if (this.lastRafAt > 0) {
      const interval = now - this.lastRafAt;
      if (Number.isFinite(interval) && interval > 0 && interval < 2000) {
        this.rafIntervals.push(interval);
        if (this.rafIntervals.length > RAF_SAMPLE_LIMIT) {
          this.rafIntervals.splice(0, this.rafIntervals.length - RAF_SAMPLE_LIMIT);
        }
      }
    }
    this.lastRafAt = now;
    // Detect high-refresh displays immediately at startup, then sample cadence
    // only twice per second. Sorting the full RAF window on every 144 Hz callback
    // was pure diagnostic work in the hottest path.
    if (this.rafIntervals.length <= 12 || now - this.lastDisplayCadenceAt >= 500) {
      this.lastDisplayCadenceAt = now;
      this.#updateDisplayCadence();
    }
    if (now - this.lastTimingStatsAt < 250 && this.rafIntervals.length > 1) return;
    this.lastTimingStatsAt = now;
    const sorted = [...this.rafIntervals].sort((a, b) => a - b);
    this.rafP50 = this.#percentile(sorted, 0.50);
    this.rafP95 = this.#percentile(sorted, 0.95);
    this.rafMax = sorted.at(-1) ?? 0;
    let long25 = 0;
    let long40 = 0;
    let long80 = 0;
    for (const value of sorted) {
      if (value > 25) long25 += 1;
      if (value > 40) long40 += 1;
      if (value > 80) long80 += 1;
    }
    this.rafLong25 = long25;
    this.rafLong40 = long40;
    this.rafLong80 = long80;
    const cutoff = now - 2000;
    while (this.trackTileGenerationTimes.length && this.trackTileGenerationTimes[0] < cutoff) {
      this.trackTileGenerationTimes.shift();
    }
    if (this.trackTileGenerationTimes.length) {
      const sampleStart = Math.max(cutoff, this.trackTileGenerationTimes[0]);
      const seconds = Math.max(0.25, (now - sampleStart) / 1000);
      this.trackTileGenerationRate = this.trackTileGenerationTimes.length / seconds;
    } else this.trackTileGenerationRate = 0;
    const renderIntervals = [...this.renderIntervals].sort((a, b) => a - b);
    this.renderIntervalP50 = this.#percentile(renderIntervals, 0.50);
    this.renderIntervalP95 = this.#percentile(renderIntervals, 0.95);
    this.renderIntervalMax = renderIntervals.at(-1) ?? 0;
    const renderCosts = [...this.renderCosts].sort((a, b) => a - b);
    this.renderCostP95 = this.#percentile(renderCosts, 0.95);
    this.renderCostMax = renderCosts.at(-1) ?? 0;
    if (this.deliveryStatsDirty) {
      const deliveryIntervals = [...this.deliveryIntervals].sort((a, b) => a - b);
      this.deliveryP95 = this.#percentile(deliveryIntervals, 0.95);
      this.deliveryMax = deliveryIntervals.at(-1) ?? 0;
      this.deliveryStatsDirty = false;
    }
    if (this.longTaskDurations.length) {
      const longTasks = [...this.longTaskDurations].sort((a, b) => a - b);
      this.longTaskP95 = this.#percentile(longTasks, 0.95);
      this.longTaskMax = longTasks.at(-1) ?? 0;
    } else {
      this.longTaskP95 = 0;
      this.longTaskMax = 0;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.longTaskObserver?.disconnect?.();
    this.longTaskObserver = null;
    if (this.resizeFrame != null) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
    this.resizePending = false;

    // Canvas backing stores are native/GPU resources. Waiting for a later JS GC
    // can leave several 2K textures alive between races in Chromium/Electron.
    // Shrinking every store releases that memory immediately.
    this.#clearLabelCache();
    this.presentationCars.clear();
    this.activePresentationIds.clear();
    this.blendedCars.length = 0;
    this.smoothedCars.length = 0;
    this.presentationOrder = null;
    this.presentationOrderSignature = "";
    this.presentationOrderCandidate = null;
    this.presentationOrderCandidateOrder = null;
    this.presentationOrderCandidateSince = 0;
    this.presentationFinishCount = 0;
    this.presentationOrderSourceTick = null;
    this.presentationPlaceById.clear();
    for (const tile of this.trackTiles.values()) {
      tile.canvas.width = 1;
      tile.canvas.height = 1;
    }
    this.trackTiles.clear();
    this.trackTileCoverage.clear();
    this.visibleTrackEntries.length = 0;
    this.retainedTrackTileKeys.clear();
    this.predictionState = null;
    this.predictionBlocked = false;
    this.predictionClearSince = 0;
    this.snapshotBuffer.length = 0;
    this.rafIntervals.length = 0;
    this.renderIntervals.length = 0;
    this.renderCosts.length = 0;
    this.deliveryIntervals.length = 0;
    this.longTaskDurations.length = 0;
    this.trackTileGenerationTimes.length = 0;
    this.previousSnapshot = null;
    this.currentSnapshot = null;
    this.playbackSource = null;
    this.playbackClockOffset = null;
    this.playbackTargetTime = null;
    this.playbackTargetAt = 0;
    this.playbackOffsetSample = null;
    this.simulationFrame = null;
    this.blendedSnapshot = null;
    this.smoothedSnapshot = null;
    this.onHud = null;
    this.trackPath = null;
    this.pitPath = null;
    this.runoffSurfacePaths = null;
    this.pitRunoffSurfacePaths = null;
    this.runoffTextureGeometry = null;
    this.wallGeometry = null;
    this.trackTileCoverage = null;
    this.visibleTrackEntries = null;
    this.retainedTrackTileKeys = null;
    this.visibleTrackTileBounds = null;
    this.trackLayerMeta = null;
    this.minimapProjection = null;

    for (const canvas of [this.trackLayer, this.minimapLayer, this.background, this.canvas]) {
      if (!canvas) continue;
      canvas.width = 1;
      canvas.height = 1;
    }
    this.trackLayerContext = null;
    this.minimapLayerContext = null;
    this.backgroundContext = null;
    this.context = null;
    this.track = null;
    this.canvas = null;
  }

  resize() {
    if (this.destroyed || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    // Keep the race view sharper than a CSS-pixel canvas on HiDPI displays, but
    // cap the total backing store so a large Foundry window does not multiply
    // fill-rate and VRAM without bound.
    const cssPixels = Math.max(1, rect.width * rect.height);
    const pixelBudgetScale = Math.sqrt(MAX_CANVAS_PIXELS / cssPixels);
    const requestedScale = clamp(Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE, pixelBudgetScale), 1, MAX_OUTPUT_SCALE);
    const width = Math.max(320, Math.round(rect.width * requestedScale));
    const height = Math.max(240, Math.round(rect.height * requestedScale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      // Use the actual backing-store/CSS ratio. Rounded canvas dimensions can be
      // a fraction away from requestedScale and that mismatch causes resampling.
      const scaleX = width / Math.max(1, rect.width);
      const scaleY = height / Math.max(1, rect.height);
      this.outputScale = (scaleX + scaleY) * 0.5;
      this.context.imageSmoothingEnabled = true;
      this.context.imageSmoothingQuality = "high";
      this.#clearLabelCache();
      this.#rebuildBackground(width, height);
      this.#rebuildMinimapLayer();
    }
  }


  #clearLabelCache() {
    for (const sprite of this.labelCache.values()) {
      const canvas = sprite?.canvas ?? sprite;
      canvas.width = 1;
      canvas.height = 1;
    }
    this.labelCache.clear();
  }

  #buildTrackPath(points, closed = true) {
    const path = new Path2D();
    if (!points?.length) return path;
    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x, points[i].y);
    if (closed) path.closePath();
    return path;
  }



  #buildRunoffSurfacePaths(points, roadWidth, closed = true, forcedSurface = null) {
    const paths = { grass: new Path2D(), sand: new Path2D(), gravel: new Path2D() };
    if (!points?.length) return paths;
    const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
    const halfRoad = Math.max(0, Number(roadWidth) || 0) * 0.5;
    for (let index = 0; index < segmentCount; index += 1) {
      const nextIndex = closed ? (index + 1) % points.length : index + 1;
      const point = points[index];
      const next = points[nextIndex];
      for (const side of [1, -1]) {
        if (grassWidthForSide(point, side) <= 0.5 && grassWidthForSide(next, side) <= 0.5) continue;
        const type = forcedSurface ?? runoffSurfaceForSide(point, side);
        const path = paths[type] ?? paths.grass;
        const innerA = { x: point.x + point.nx * halfRoad * side, y: point.y + point.ny * halfRoad * side };
        const innerB = { x: next.x + next.nx * halfRoad * side, y: next.y + next.ny * halfRoad * side };
        const outerA = wallBoundaryPoint(point, roadWidth, side);
        const outerB = wallBoundaryPoint(next, roadWidth, side);
        path.moveTo(innerA.x, innerA.y);
        path.lineTo(innerB.x, innerB.y);
        path.lineTo(outerB.x, outerB.y);
        path.lineTo(outerA.x, outerA.y);
        path.closePath();
      }
    }
    return paths;
  }

  #buildRunoffTextureGeometry(points, roadWidth) {
    const geometry = {
      grass: [new Path2D(), new Path2D(), new Path2D()],
      sand: [new Path2D(), new Path2D()],
      gravel: [new Path2D(), new Path2D(), new Path2D()]
    };
    if (!points?.length) return geometry;
    for (let index = 0; index < points.length; index += 3) {
      const point = points[index];
      for (const side of [1, -1]) {
        const width = grassWidthForSide(point, side);
        if (width < 10) continue;
        const type = runoffSurfaceForSide(point, side);
        const noise = Math.sin(index * 12.9898 + side * 78.233) * 43758.5453;
        const unit = noise - Math.floor(noise);
        const offset = roadWidth * 0.5 + width * (0.16 + unit * 0.70);
        const centerX = point.x + point.nx * offset * side;
        const centerY = point.y + point.ny * offset * side;
        if (type === "grass") {
          const length = 9 + unit * 23;
          const sway = (unit - 0.5) * Math.min(9, width * 0.08);
          const path = geometry.grass[Math.floor(unit * geometry.grass.length) % geometry.grass.length];
          path.moveTo(centerX - point.tx * length * 0.5 + point.nx * sway, centerY - point.ty * length * 0.5 + point.ny * sway);
          path.lineTo(centerX + point.tx * length * 0.5 - point.nx * sway, centerY + point.ty * length * 0.5 - point.ny * sway);
        } else if (type === "sand") {
          const path = geometry.sand[Math.floor(unit * geometry.sand.length) % geometry.sand.length];
          const length = 8 + unit * 18;
          const bow = (unit - 0.5) * 5;
          path.moveTo(centerX - point.tx * length * 0.5, centerY - point.ty * length * 0.5);
          path.quadraticCurveTo(centerX + point.nx * bow, centerY + point.ny * bow, centerX + point.tx * length * 0.5, centerY + point.ty * length * 0.5);
        } else {
          const path = geometry.gravel[Math.floor(unit * geometry.gravel.length) % geometry.gravel.length];
          const radius = 1.4 + unit * 2.8;
          path.moveTo(centerX + radius, centerY);
          path.arc(centerX, centerY, radius, 0, Math.PI * 2);
          if (width > 42) {
            const secondX = centerX + point.tx * (8 + unit * 11) + point.nx * side * 4;
            const secondY = centerY + point.ty * (8 + unit * 11) + point.ny * side * 4;
            path.moveTo(secondX + radius * 0.65, secondY);
            path.arc(secondX, secondY, radius * 0.65, 0, Math.PI * 2);
          }
        }
      }
    }
    return geometry;
  }

  #drawRunoffTextures(ctx) {
    const grassLayers = [
      { color: "rgba(31, 48, 25, 0.30)", width: 2.4 },
      { color: "rgba(112, 126, 66, 0.22)", width: 1.6 },
      { color: "rgba(186, 169, 96, 0.13)", width: 1.1 }
    ];
    const sandLayers = [
      { color: "rgba(82, 61, 37, 0.22)", width: 1.5 },
      { color: "rgba(238, 213, 158, 0.22)", width: 1.0 }
    ];
    const gravelLayers = [
      { color: "rgba(34, 32, 29, 0.42)" },
      { color: "rgba(129, 124, 113, 0.48)" },
      { color: "rgba(211, 202, 180, 0.30)" }
    ];
    ctx.save();
    ctx.lineCap = "round";
    for (let index = 0; index < grassLayers.length; index += 1) {
      ctx.strokeStyle = grassLayers[index].color;
      ctx.lineWidth = grassLayers[index].width;
      ctx.stroke(this.runoffTextureGeometry?.grass?.[index] ?? new Path2D());
    }
    for (let index = 0; index < sandLayers.length; index += 1) {
      ctx.strokeStyle = sandLayers[index].color;
      ctx.lineWidth = sandLayers[index].width;
      ctx.stroke(this.runoffTextureGeometry?.sand?.[index] ?? new Path2D());
    }
    for (let index = 0; index < gravelLayers.length; index += 1) {
      ctx.fillStyle = gravelLayers[index].color;
      ctx.fill(this.runoffTextureGeometry?.gravel?.[index] ?? new Path2D());
    }
    ctx.restore();
  }

  #buildBoundaryWallGeometry(points, roadWidth, side, closed = true, alphaKey = null) {
    const solidPath = new Path2D();
    const fadedBuckets = Array.from({ length: WALL_FADE_BUCKETS }, () => ({ path: new Path2D(), used: false }));
    if (!points?.length) return { solidPath, fadedPaths: [] };
    const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
    for (let index = 0; index < segmentCount; index += 1) {
      const nextIndex = closed ? (index + 1) % points.length : index + 1;
      const point = points[index];
      const next = points[nextIndex];
      const active = alphaKey
        ? wallSegmentActiveRange(point, next, side, 0.025)
        : { startT: 0, endT: 1, averageAlpha: 1 };
      if (!active) continue;
      const rawA = wallBoundaryPoint(point, roadWidth, side);
      const rawB = wallBoundaryPoint(next, roadWidth, side);
      const a = {
        x: rawA.x + (rawB.x - rawA.x) * active.startT,
        y: rawA.y + (rawB.y - rawA.y) * active.startT
      };
      const b = {
        x: rawA.x + (rawB.x - rawA.x) * active.endT,
        y: rawA.y + (rawB.y - rawA.y) * active.endT
      };
      const alpha = clamp(active.averageAlpha, 0, 1);
      if (alpha >= 0.985) {
        solidPath.moveTo(a.x, a.y);
        solidPath.lineTo(b.x, b.y);
        continue;
      }
      const bucketIndex = Math.min(WALL_FADE_BUCKETS - 1, Math.floor(alpha * WALL_FADE_BUCKETS));
      const bucket = fadedBuckets[bucketIndex];
      bucket.path.moveTo(a.x, a.y);
      bucket.path.lineTo(b.x, b.y);
      bucket.used = true;
    }
    const fadedPaths = fadedBuckets.flatMap((bucket, index) => bucket.used
      ? [{ path: bucket.path, alpha: (index + 0.5) / WALL_FADE_BUCKETS }]
      : []);
    return { solidPath, fadedPaths };
  }

  #drawBoundaryWallGeometry(ctx, geometry) {
    if (!geometry) return;
    const layers = [
      { color: "#292725", width: 10, alpha: 1 },
      { color: "#aaa497", width: 4, alpha: 1 },
      { color: "rgba(238, 227, 196, 0.72)", width: 1.5, alpha: 0.92, dash: [18, 12] }
    ];
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const layer of layers) {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.setLineDash(layer.dash ?? []);
      ctx.globalAlpha = layer.alpha;
      ctx.stroke(geometry.solidPath);
      for (const faded of geometry.fadedPaths) {
        ctx.globalAlpha = faded.alpha * layer.alpha;
        ctx.stroke(faded.path);
      }
    }
    ctx.restore();
  }

  #rebuildTrackLayer() {
    const ctx = this.trackLayerContext;
    if (!ctx) return;
    const maxTrackGrass = Math.max(0, ...this.track.samples.flatMap((point) => [grassWidthForSide(point, 1), grassWidthForSide(point, -1)]));
    const maxPitGrass = Math.max(0, ...(this.track.pit?.samples ?? []).flatMap((point) => [grassWidthForSide(point, 1), grassWidthForSide(point, -1)]));
    const padding = Math.max(this.track.width * 0.5 + maxTrackGrass, (this.track.pit?.width ?? 0) * 0.5 + maxPitGrass) + 72;
    const minX = this.track.bounds.minX - padding;
    const minY = this.track.bounds.minY - padding;
    const worldWidth = this.track.bounds.maxX - this.track.bounds.minX + padding * 2;
    const worldHeight = this.track.bounds.maxY - this.track.bounds.minY + padding * 2;
    // The track layer is static and then scaled by the camera. A 4K backing
    // canvas cost substantial VRAM on integrated GPUs without adding visible
    // detail at the module's one-to-one render scale.
    const layerScale = Math.max(0.24, Math.min(0.82, MAX_STATIC_LAYER_SIZE / worldWidth, MAX_STATIC_LAYER_SIZE / worldHeight));
    this.trackLayer.width = Math.max(1, Math.ceil(worldWidth * layerScale));
    this.trackLayer.height = Math.max(1, Math.ceil(worldHeight * layerScale));
    ctx.setTransform(layerScale, 0, 0, layerScale, -minX * layerScale, -minY * layerScale);
    ctx.clearRect(minX, minY, worldWidth, worldHeight);
    this.#paintStaticTrack(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.trackLayerMeta = { minX, minY, worldWidth, worldHeight, layerScale };
  }

  #rebuildMinimapLayer() {
    const ctx = this.minimapLayerContext;
    if (!ctx) return;
    const s = this.outputScale;
    const boxWidth = Math.round(218 * s);
    const boxHeight = Math.round(148 * s);
    const padding = Math.round(13 * s);
    this.minimapLayer.width = boxWidth;
    this.minimapLayer.height = boxHeight;

    this.#roundedRect(ctx, 0, 0, boxWidth, boxHeight, Math.round(9 * s));
    ctx.fillStyle = "rgba(10, 15, 18, 0.84)";
    ctx.fill();
    ctx.strokeStyle = "rgba(113, 145, 157, 0.48)";
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();

    const bounds = this.track.bounds;
    const rangeX = Math.max(1, bounds.maxX - bounds.minX);
    const rangeY = Math.max(1, bounds.maxY - bounds.minY);
    const mapScale = Math.min((boxWidth - padding * 2) / rangeX, (boxHeight - padding * 2) / rangeY);
    const contentWidth = rangeX * mapScale;
    const contentHeight = rangeY * mapScale;
    const originX = (boxWidth - contentWidth) * 0.5 - bounds.minX * mapScale;
    const originY = (boxHeight - contentHeight) * 0.5 - bounds.minY * mapScale;

    ctx.save();
    this.#roundedRect(ctx, 2, 2, boxWidth - 4, boxHeight - 4, Math.round(8 * s));
    ctx.clip();
    ctx.translate(originX, originY);
    ctx.scale(mapScale, mapScale);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(32, 42, 47, 0.98)";
    ctx.lineWidth = 5 / mapScale;
    ctx.stroke(this.trackPath);
    ctx.strokeStyle = "rgba(184, 164, 119, 0.88)";
    ctx.lineWidth = 2 / mapScale;
    ctx.stroke(this.trackPath);
    if (this.track.pit?.samples?.length) {
      ctx.strokeStyle = "rgba(88, 126, 137, 0.95)";
      ctx.lineWidth = 2.5 / mapScale;
      ctx.stroke(this.pitPath);
      ctx.strokeStyle = "rgba(176, 219, 226, 0.72)";
      ctx.lineWidth = 1 / mapScale;
      ctx.stroke(this.pitPath);
    }
    ctx.restore();

    ctx.fillStyle = "rgba(213, 226, 231, 0.72)";
    ctx.font = `700 ${Math.round(8 * s)}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("ТРАССА", Math.round(9 * s), Math.round(7 * s));
    this.minimapProjection = { boxWidth, boxHeight, originX, originY, mapScale };
  }

  #rebuildBackground(width, height) {
    this.background.width = width;
    this.background.height = height;
    const ctx = this.backgroundContext;
    if (!ctx) return;
    const gradient = ctx.createRadialGradient(width * 0.5, height * 0.42, 10, width * 0.5, height * 0.5, Math.max(width, height));
    gradient.addColorStop(0, "#312b24");
    gradient.addColorStop(1, "#12100e");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  #blendSnapshots(previous, current, alpha) {
    if (!current) return null;
    if (!previous) return current;
    const t = clamp(alpha, 0, 1);
    const previousCars = previous.cars ?? [];
    const currentCars = current.cars ?? [];
    const blended = this.blendedSnapshot;
    const cars = this.blendedCars;
    Object.assign(blended, current);
    blended.simulationTime = this.#snapshotClock(previous) + (this.#snapshotClock(current) - this.#snapshotClock(previous)) * t;
    blended.time = previous.time + (current.time - previous.time) * t;
    blended.countdown = previous.countdown + (current.countdown - previous.countdown) * t;
    blended.cars = cars;
    cars.length = currentCars.length;

    for (let index = 0; index < currentCars.length; index += 1) {
      const car = currentCars[index];
      let target = cars[index];
      if (!target || target.id !== car.id) target = cars[index] = {};
      Object.assign(target, car);
      // Race car order is fixed by race-init. Use the matching index in the
      // hot path and only fall back to a linear lookup for malformed/reordered
      // snapshots, avoiding a Map allocation on every rendered frame.
      const indexed = previousCars[index];
      const old = indexed?.id === car.id ? indexed : previousCars.find((entry) => entry.id === car.id);
      if (!old) continue;
      target.x = old.x + (car.x - old.x) * t;
      target.y = old.y + (car.y - old.y) * t;
      target.vx = old.vx + (car.vx - old.vx) * t;
      target.vy = old.vy + (car.vy - old.vy) * t;
      target.angle = old.angle + angleDelta(car.angle, old.angle) * t;
      target.health = old.health + (car.health - old.health) * t;
      target.charge = old.charge + (car.charge - old.charge) * t;
      target.heat = old.heat + (car.heat - old.heat) * t;
      target.currentLapTime = this.#lerpOptional(old.currentLapTime, car.currentLapTime, t);
      target.lastLapTime = this.#lerpOptional(old.lastLapTime, car.lastLapTime, t);
      target.bestLapTime = this.#lerpOptional(old.bestLapTime, car.bestLapTime, t);
    }
    return blended;
  }

  #lerpOptional(a, b, t) {
    if (!Number.isFinite(b)) return b;
    if (!Number.isFinite(a)) return b;
    return a + (b - a) * t;
  }

  #interpolatedSnapshot(now) {
    if (this.simulationFrame) {
      const { previous, current, alpha } = this.simulationFrame;
      return this.#blendSnapshots(previous, current, alpha);
    }

    const buffer = this.snapshotBuffer;
    if (!buffer.length) return this.currentSnapshot;
    const latest = buffer[buffer.length - 1];
    const offset = Number(this.playbackClockOffset);
    const fallbackSourceAt = Number.isFinite(latest.presentationAt) ? latest.presentationAt : latest.receivedAt;
    const rawTargetTime = Number.isFinite(offset)
      ? now / 1000 - offset - this.networkRenderDelay
      : latest.time + Math.max(0, now - fallbackSourceAt) / 1000 - this.networkRenderDelay;

    let targetTime = rawTargetTime;
    if (Number.isFinite(this.playbackTargetTime)) {
      const elapsed = Math.max(0, Math.min(0.25, (now - this.playbackTargetAt) / 1000));
      // Never rewind presentation because a newly arrived packet was slower.
      // A better low-latency clock sample is adopted gradually instead of
      // jumping the entire scene forward in one frame.
      const maximumAdvance = this.playbackTargetTime + elapsed * 1.25 + 0.004;
      targetTime = clamp(rawTargetTime, this.playbackTargetTime, maximumAdvance);
    }
    targetTime = Math.min(targetTime, latest.time + this.maxExtrapolation);
    this.playbackTargetTime = targetTime;
    this.playbackTargetAt = now;

    while (buffer.length > 3 && buffer[1].time < targetTime - 0.35) buffer.shift();
    for (let index = 0; index < buffer.length - 1; index += 1) {
      const a = buffer[index];
      const b = buffer[index + 1];
      if (targetTime < a.time || targetTime > b.time) continue;
      const span = Math.max(0.0001, b.time - a.time);
      return this.#blendSnapshots(a.snapshot, b.snapshot, (targetTime - a.time) / span);
    }

    if (targetTime <= buffer[0].time) return buffer[0].snapshot;
    return this.#extrapolateSnapshot(latest.snapshot, Math.min(this.maxExtrapolation, targetTime - latest.time));
  }

  #extrapolateSnapshot(snapshot, seconds) {
    if (!snapshot || seconds <= 0) return snapshot;
    const previous = this.snapshotBuffer.length > 1 ? this.snapshotBuffer[this.snapshotBuffer.length - 2].snapshot : null;
    const previousCars = previous?.cars ?? [];
    const frameSpan = Math.max(0.001, this.#snapshotClock(snapshot) - this.#snapshotClock(previous));
    const duringCountdown = !snapshot.started && Number(snapshot.countdown) > 0;
    return {
      ...snapshot,
      simulationTime: this.#snapshotClock(snapshot) + seconds,
      time: duringCountdown ? Number(snapshot.time) : Number(snapshot.time) + seconds,
      countdown: duringCountdown ? Math.max(0, Number(snapshot.countdown) - seconds) : snapshot.countdown,
      cars: snapshot.cars.map((car, index) => {
        if (car.finished || car.disabled || car.pitState === "service"
          || Number(car.surfaceSeverity) > 0.02 || Number(car.wallContactTimer) > 0.01) return car;
        const indexed = previousCars[index];
        const old = indexed?.id === car.id ? indexed : previousCars.find((entry) => entry.id === car.id);
        const angularRate = old ? angleDelta(car.angle, old.angle) / frameSpan : 0;
        const damping = Math.exp(-seconds * 0.35);
        return {
          ...car,
          x: car.x + car.vx * seconds * damping,
          y: car.y + car.vy * seconds * damping,
          angle: car.angle + angularRate * seconds * damping,
          currentLapTime: Number.isFinite(car.currentLapTime) ? car.currentLapTime + seconds : car.currentLapTime
        };
      })
    };
  }

  #smoothNetworkSnapshot(snapshot, dt) {
    if (!snapshot) return snapshot;
    const cars = this.smoothedCars;
    const activeIds = this.activePresentationIds;
    cars.length = 0;
    activeIds.clear();
    for (const car of snapshot.cars ?? []) {
      activeIds.add(car.id);
      let displayed = this.presentationCars.get(car.id);
      if (!displayed) {
        displayed = { ...car };
        this.presentationCars.set(car.id, displayed);
      } else {
        const distance = Math.hypot(car.x - displayed.x, car.y - displayed.y);
        const factor = distance > 520 ? 1 : smoothingFactor(dt, car.id === this.localCarId ? 0.045 : 0.065);
        const x = displayed.x + (car.x - displayed.x) * factor;
        const y = displayed.y + (car.y - displayed.y) * factor;
        const vx = displayed.vx + (car.vx - displayed.vx) * factor;
        const vy = displayed.vy + (car.vy - displayed.vy) * factor;
        const angle = displayed.angle + angleDelta(car.angle, displayed.angle) * factor;
        Object.assign(displayed, car, { x, y, vx, vy, angle });
      }
      cars.push(displayed);
    }
    if (this.presentationCars.size > cars.length) {
      for (const id of this.presentationCars.keys()) {
        if (!activeIds.has(id)) this.presentationCars.delete(id);
      }
    }
    const smoothed = this.smoothedSnapshot;
    Object.assign(smoothed, snapshot);
    smoothed.cars = cars;
    return smoothed;
  }



  #stabilizeRaceOrder(snapshot, now) {
    if (!snapshot?.cars?.length) return snapshot;
    const finishCount = Array.isArray(snapshot.finishOrder) ? snapshot.finishOrder.length : 0;
    const sourceTick = Number(snapshot.tick);
    const sourceChanged = sourceTick !== this.presentationOrderSourceTick || finishCount !== this.presentationFinishCount;
    let orderChanged = false;

    if (sourceChanged) {
      this.presentationOrderSourceTick = sourceTick;
      const orderedCars = snapshot.cars.slice();
      orderedCars.sort((a, b) => (Number(a.place) || 999) - (Number(b.place) || 999)
        || String(a.id).localeCompare(String(b.id)));
      const rawOrder = orderedCars.map((car) => String(car.id));
      const signature = rawOrder.join("\u0000");

      if (!this.presentationOrder) {
        this.presentationOrder = rawOrder;
        this.presentationOrderSignature = signature;
        this.presentationOrderCandidate = signature;
        this.presentationOrderCandidateOrder = rawOrder;
        this.presentationOrderCandidateSince = now;
        orderChanged = true;
      } else if (signature === this.presentationOrderSignature) {
        this.presentationOrderCandidate = signature;
        this.presentationOrderCandidateOrder = rawOrder;
        this.presentationOrderCandidateSince = now;
      } else if (finishCount !== this.presentationFinishCount || snapshot.finished) {
        this.presentationOrder = rawOrder;
        this.presentationOrderSignature = signature;
        this.presentationOrderCandidate = signature;
        this.presentationOrderCandidateOrder = rawOrder;
        this.presentationOrderCandidateSince = now;
        orderChanged = true;
      } else if (signature !== this.presentationOrderCandidate) {
        this.presentationOrderCandidate = signature;
        this.presentationOrderCandidateOrder = rawOrder;
        this.presentationOrderCandidateSince = now;
      } else if (now - this.presentationOrderCandidateSince >= PLACE_ORDER_STABILITY_MS) {
        this.presentationOrder = rawOrder;
        this.presentationOrderSignature = signature;
        this.presentationOrderCandidateOrder = rawOrder;
        this.presentationOrderCandidateSince = now;
        orderChanged = true;
      }
      this.presentationFinishCount = finishCount;
    } else if (this.presentationOrderCandidate !== this.presentationOrderSignature
      && Array.isArray(this.presentationOrderCandidateOrder)
      && now - this.presentationOrderCandidateSince >= PLACE_ORDER_STABILITY_MS) {
      // The renderer may draw several frames from the same authoritative tick.
      // Let the candidate mature on those frames without sorting the cars again.
      this.presentationOrder = this.presentationOrderCandidateOrder;
      this.presentationOrderSignature = this.presentationOrderCandidate;
      this.presentationOrderCandidateSince = now;
      orderChanged = true;
    }

    if (orderChanged || this.presentationPlaceById.size !== this.presentationOrder.length) {
      this.presentationPlaceById.clear();
      for (let index = 0; index < this.presentationOrder.length; index += 1) {
        this.presentationPlaceById.set(this.presentationOrder[index], index + 1);
      }
    }

    let cars = null;
    for (let index = 0; index < snapshot.cars.length; index += 1) {
      const car = snapshot.cars[index];
      const place = this.presentationPlaceById.get(String(car.id));
      if (!Number.isFinite(place) || place === Number(car.place)) continue;
      cars ??= snapshot.cars.slice();
      cars[index] = { ...car, place };
    }
    return cars ? { ...snapshot, cars } : snapshot;
  }


  #applyLocalPrediction(snapshot, now, dt) {
    if (!snapshot || !this.localCarId || this.simulationFrame || !this.enableLocalPrediction) return snapshot;
    const authoritative = this.currentSnapshot?.cars?.find((car) => car.id === this.localCarId)
      ?? snapshot.cars?.find((car) => car.id === this.localCarId);
    if (!authoritative) {
      this.predictionState = null;
      return snapshot;
    }

    const surfaceSeverity = Number(authoritative.surfaceSeverity) || 0;
    const wallContactTimer = Number(authoritative.wallContactTimer) || 0;
    // Terrain is a normal driving state, not a reason to disable local prediction.
    // The previous surfaceSeverity gate returned the client to the delayed
    // authoritative presentation buffer for roughly 160 ms, then restored the
    // predicted pose. Only remote players therefore appeared to jump backwards
    // on entering grass, sand or gravel and immediately spring forwards again.
    const unsafeContact = wallContactTimer > 0.02;
    const contactCleared = wallContactTimer < 0.005;
    if (unsafeContact) {
      this.predictionBlocked = true;
      this.predictionClearSince = 0;
    } else if (this.predictionBlocked) {
      if (contactCleared) {
        if (!this.predictionClearSince) this.predictionClearSince = now;
        if (now - this.predictionClearSince >= 120) {
          this.predictionBlocked = false;
          this.predictionClearSince = 0;
        }
      } else this.predictionClearSince = 0;
    }

    if (authoritative.finished || authoritative.disabled || authoritative.pitState === "service"
      || this.predictionBlocked || !snapshot.started) {
      this.predictionState = {
        ...authoritative,
        angularVelocity: 0,
        driftAmount: 0,
        driftDirection: 0,
        slipAngle: 0,
        lastSteer: 0,
        lastAt: now,
        sourceTick: Number(this.currentSnapshot?.tick ?? snapshot.tick)
      };
      this.predictionError = 0;
      this.predictionCorrection = 0;
      return snapshot;
    }

    const sourceTick = Number(this.currentSnapshot?.tick ?? snapshot.tick) || 0;
    const p = authoritative.prediction ?? {};
    let state = this.predictionState;
    if (!state) {
      state = {
        ...authoritative,
        angularVelocity: 0,
        driftAmount: 0,
        driftDirection: 0,
        slipAngle: 0,
        lastSteer: 0,
        correctionX: 0,
        correctionY: 0,
        correctionVx: 0,
        correctionVy: 0,
        correctionAngle: 0,
        correctionTime: 0.18,
        lastAt: now,
        sourceTick
      };
      this.predictionState = state;
    } else if (state.sourceTick !== sourceTick) {
      const errorX = authoritative.x - state.x;
      const errorY = authoritative.y - state.y;
      const error = Math.hypot(errorX, errorY);
      this.predictionError = error;
      if (error > 260 || authoritative.pitState !== state.pitState) {
        Object.assign(state, authoritative, {
          angularVelocity: 0,
          driftAmount: 0,
          driftDirection: 0,
          slipAngle: 0,
            lastSteer: 0,
          correctionX: 0,
          correctionY: 0,
          correctionVx: 0,
          correctionVy: 0,
          correctionAngle: 0
        });
      } else {
        const acknowledged = Number(authoritative.inputSequence) >= this.localInputSequence;
        const motion = {
          x: state.x,
          y: state.y,
          vx: state.vx,
          vy: state.vy,
          angle: state.angle,
          angularVelocity: state.angularVelocity ?? 0,
          driftAmount: state.driftAmount ?? 0,
          driftDirection: state.driftDirection ?? 0,
          slipAngle: state.slipAngle ?? 0,
          lastSteer: state.lastSteer ?? 0
        };
        Object.assign(state, authoritative, motion, {
          // Reconciliation is stored as a decaying error rather than applied as
          // an instant position jump every network tick.
          correctionX: clamp(errorX, -180, 180),
          correctionY: clamp(errorY, -180, 180),
          correctionVx: clamp(authoritative.vx - state.vx, -220, 220),
          correctionVy: clamp(authoritative.vy - state.vy, -220, 220),
          correctionAngle: clamp(angleDelta(authoritative.angle, state.angle), -0.7, 0.7),
          correctionTime: acknowledged ? 0.14 : 0.24
        });
      }
      state.sourceTick = sourceTick;
    }

    const step = clamp(dt, 0, 0.05);
    if (step > 0) {
      const reconcile = smoothingFactor(step, Number(state.correctionTime) || 0.18);
      const correctionX = Number(state.correctionX) || 0;
      const correctionY = Number(state.correctionY) || 0;
      const correctionVx = Number(state.correctionVx) || 0;
      const correctionVy = Number(state.correctionVy) || 0;
      const correctionAngle = Number(state.correctionAngle) || 0;
      state.x += correctionX * reconcile;
      state.y += correctionY * reconcile;
      state.vx += correctionVx * reconcile;
      state.vy += correctionVy * reconcile;
      state.angle += correctionAngle * reconcile;
      state.correctionX = correctionX * (1 - reconcile);
      state.correctionY = correctionY * (1 - reconcile);
      state.correctionVx = correctionVx * (1 - reconcile);
      state.correctionVy = correctionVy * (1 - reconcile);
      state.correctionAngle = correctionAngle * (1 - reconcile);
      this.predictionCorrection = Math.hypot(state.correctionX, state.correctionY);

      const input = this.localInput;
      const maxSpeed = Math.max(80, Number(p.maxSpeed) || 420);
      const maxHealth = Math.max(1, Number(state.maxHealth) || 100);
      const heat = Math.max(0, Number(state.heat) || 0);
      if (state.overheated && heat <= 48) state.overheated = false;
      const heatStress = clamp((heat - 68) / 32, 0, 1);
      const thermalAcceleration = state.overheated ? 0.58 : 1 - heatStress * 0.28;
      const thermalSteering = state.overheated ? 0.72 : 1 - heatStress * 0.13;
      const thermalTopSpeed = state.overheated ? 0.78 : 1 - heatStress * 0.08;
      const terrainSeverity = clamp(surfaceSeverity / Math.max(1, Number(p.offroadGrip) || 1), 0, 1);
      const terrainAcceleration = 1 - terrainSeverity * 0.68;
      const terrainSteering = 1 - terrainSeverity * 0.48;
      const terrainTopSpeed = 1 - terrainSeverity * 0.58;
      const terrainGrip = 1 - terrainSeverity * 0.78;
      const healthPenalty = Number(state.health) < maxHealth * 0.25 ? 0.78 : 1;
      const lastLapBoost = p.lastLap && Number(state.lap) === Number(snapshot.laps) - 1 ? 1.04 : 1;
      const lowHealthBoost = Number(state.health) < maxHealth * 0.3 ? Math.max(1, Number(p.lowHealthBoost) || 1) : 1;

      const boostDrain = Math.max(0.01, Number(p.boostDrain) || 25);
      const requestedCharge = boostDrain * step;
      const boostRequested = state.pitState === "track"
        && input.boost && input.throttle > 0 && !state.overheated && Number(state.charge) > 0.001;
      const boostFraction = boostRequested
        ? clamp(Number(state.charge) / Math.max(0.0001, requestedCharge), 0, 1)
        : 0;
      let boostActive = boostFraction > 0.001;
      if (boostActive) {
        state.charge = Math.max(0, Number(state.charge) - requestedCharge * boostFraction);
        state.heat = Math.min(112, heat + Math.max(0, Number(p.heatRate) || 40) * step * boostFraction);
      } else {
        state.heat = Math.max(0, heat - Math.max(0, Number(p.cooling) || 5) * step);
      }
      if (state.heat >= 100) {
        state.overheated = true;
        boostActive = false;
      }

      const drive = applyDriveModel(state, input, {
        maxSpeed,
        acceleration: Math.max(20, Number(p.acceleration) || 240),
        reverseAcceleration: Math.max(20, Number(p.reverseAcceleration) || 95),
        braking: Math.max(20, Number(p.braking) || 300),
        steerRate: Math.max(0.1, Number(p.steerRate) || 1.5),
        lateralGrip: Math.max(0.01, Number(p.lateralGrip) || 2.8),
        longitudinalDrag: Math.max(0, Number(p.longitudinalDrag) || 0.25),
        rollingDrag: Math.max(0, Number(p.rollingDrag) || 20),
        spinResistance: Math.max(0.01, Number(p.spinResistance) || 1),
        recovery: Math.max(0.2, Number(p.recovery) || 1)
      }, step, {
        accelerationMultiplier: healthPenalty * thermalAcceleration * terrainAcceleration * lastLapBoost,
        steeringMultiplier: (input.ram ? Math.max(0.01, Number(p.ramSteerPenalty) || 0.55) : 1)
          * thermalSteering * terrainSteering * (p.precision ? 1.04 : 1),
        topSpeedMultiplier: thermalTopSpeed * terrainTopSpeed * lastLapBoost,
        gripMultiplier: terrainGrip,
        brakeGripMultiplier: p.lateBrake ? 1.22 : 1,
        driftEnabled: state.pitState === "track" && terrainSeverity < 0.035,
        driftAssist: Math.max(0.75, Number(p.drift) || 1),
        driftControl: Math.max(0.45, Math.sqrt(
          Math.max(0.01, Number(p.spinResistance) || 1)
          * Math.max(0.01, Number(p.recovery) || 1)
        ) * (1 + (Math.max(0.75, Number(p.drift) || 1) - 1) * 0.75)),
        boostAccelerationMultiplier: boostFraction > 0
          ? 0.95 * Math.max(0.3, Number(p.boostPower) || 1) * lowHealthBoost * boostFraction
          : 0,
        boostTopSpeedMultiplier: boostActive ? 1.17 * Math.max(0.3, Number(p.boostPower) || 1) : 1,
        speedLimit: state.pitState !== "track" ? this.track.pit.speedLimit : Infinity,
        speedLimitDeceleration: state.pitState !== "track" ? Number(this.track.pit.speedLimitDeceleration ?? 96) : 0,
        previousSteer: state.lastSteer,
        smoothSteer: Boolean(p.smoothSteer)
      });
      state.lastSteer = drive.steering;
      state.lastAt = now;
    }

    const cars = snapshot.cars.map((car) => car.id === this.localCarId ? {
      ...car,
      x: state.x, y: state.y, vx: state.vx, vy: state.vy, angle: state.angle,
      driftAmount: state.driftAmount, slipAngle: state.slipAngle,
      surfaceSeverity: state.surfaceSeverity,
      surfaceType: state.surfaceType,
      surfaceSide: state.surfaceSide
    } : car);
    return { ...snapshot, cars };
  }

  #trackTileKey(tileX, tileY) {
    return `${tileX}:${tileY}`;
  }

  #buildTrackTileCoverage() {
    const coverage = new Set();
    const markPolyline = (points, roadWidth, closed) => {
      if (!points?.length) return;
      const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
      for (let index = 0; index < segmentCount; index += 1) {
        const nextIndex = closed ? (index + 1) % points.length : index + 1;
        const a = points[index];
        const b = points[nextIndex];
        const grassRadius = Math.max(
          grassWidthForSide(a, 1), grassWidthForSide(a, -1),
          grassWidthForSide(b, 1), grassWidthForSide(b, -1)
        );
        const radius = roadWidth * 0.5 + grassRadius + 24;
        const minTileX = Math.floor((Math.min(a.x, b.x) - radius) / TRACK_TILE_WORLD_SIZE);
        const maxTileX = Math.floor((Math.max(a.x, b.x) + radius) / TRACK_TILE_WORLD_SIZE);
        const minTileY = Math.floor((Math.min(a.y, b.y) - radius) / TRACK_TILE_WORLD_SIZE);
        const maxTileY = Math.floor((Math.max(a.y, b.y) + radius) / TRACK_TILE_WORLD_SIZE);
        for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
          for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) coverage.add(this.#trackTileKey(tileX, tileY));
        }
      }
    };
    markPolyline(this.track.samples, this.track.width, true);
    markPolyline(this.track.pit?.samples ?? [], this.track.pit?.width ?? 0, false);
    for (const obstacle of this.track.scenery ?? []) {
      const radius = Math.max(12, Number(obstacle.visualRadius) || Number(obstacle.collisionRadius) || 12) + 18;
      const minTileX = Math.floor((obstacle.x - radius) / TRACK_TILE_WORLD_SIZE);
      const maxTileX = Math.floor((obstacle.x + radius) / TRACK_TILE_WORLD_SIZE);
      const minTileY = Math.floor((obstacle.y - radius) / TRACK_TILE_WORLD_SIZE);
      const maxTileY = Math.floor((obstacle.y + radius) / TRACK_TILE_WORLD_SIZE);
      for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
        for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) coverage.add(this.#trackTileKey(tileX, tileY));
      }
    }
    return coverage;
  }

  #visibleTrackTileCoordinates(worldScale) {
    const halfWidth = this.canvas.width * 0.5 / Math.max(0.1, worldScale);
    const halfHeight = this.canvas.height * 0.5 / Math.max(0.1, worldScale);
    const cos = Math.cos(this.camera.rotation);
    const sin = Math.sin(this.camera.rotation);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let corner = 0; corner < 4; corner += 1) {
      const screenX = corner & 1 ? halfWidth : -halfWidth;
      const screenY = corner & 2 ? halfHeight : -halfHeight;
      const worldX = this.camera.x + screenX * cos + screenY * sin;
      const worldY = this.camera.y - screenX * sin + screenY * cos;
      minX = Math.min(minX, worldX);
      maxX = Math.max(maxX, worldX);
      minY = Math.min(minY, worldY);
      maxY = Math.max(maxY, worldY);
    }
    // Warm a narrow ring before it enters the viewport so active driving does
    // not pay the tile-build cost exactly on a screen-edge crossing.
    const padding = 96;
    const bounds = this.visibleTrackTileBounds;
    bounds.minTileX = Math.floor((minX - padding) / TRACK_TILE_WORLD_SIZE);
    bounds.maxTileX = Math.floor((maxX + padding) / TRACK_TILE_WORLD_SIZE);
    bounds.minTileY = Math.floor((minY - padding) / TRACK_TILE_WORLD_SIZE);
    bounds.maxTileY = Math.floor((maxY + padding) / TRACK_TILE_WORLD_SIZE);
    return bounds;
  }


  #createTrackTile(tileX, tileY, recycledTile = null) {
    const coreX = tileX * TRACK_TILE_WORLD_SIZE;
    const coreY = tileY * TRACK_TILE_WORLD_SIZE;
    const worldX = coreX - TRACK_TILE_BLEED;
    const worldY = coreY - TRACK_TILE_BLEED;
    const worldSize = TRACK_TILE_WORLD_SIZE + TRACK_TILE_BLEED * 2;
    const pixelSize = Math.round(worldSize * TRACK_TILE_SCALE);
    const canvas = recycledTile?.canvas ?? document.createElement("canvas");
    let ctx = recycledTile?.context ?? null;
    if (!recycledTile) this.trackTileAllocations += 1;
    else this.trackTileReuses += 1;
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
      ctx = null;
    }
    ctx ??= canvas.getContext("2d", { alpha: true });
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    ctx.setTransform(TRACK_TILE_SCALE, 0, 0, TRACK_TILE_SCALE, -worldX * TRACK_TILE_SCALE, -worldY * TRACK_TILE_SCALE);
    ctx.beginPath();
    ctx.rect(worldX, worldY, worldSize, worldSize);
    ctx.clip();
    this.#paintStaticTrack(ctx);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.trackTileGenerated += 1;
    const now = performance.now();
    this.trackTileGenerationTimes.push(now);
    return { canvas, context: ctx, coreX, coreY, used: ++this.trackTileUseCounter };
  }

  #drawTrackLayerRegion(ctx, worldX, worldY, worldSize) {
    const meta = this.trackLayerMeta;
    if (!meta || !this.trackLayer.width || !this.trackLayer.height) return;
    const left = Math.max(worldX, meta.minX);
    const top = Math.max(worldY, meta.minY);
    const right = Math.min(worldX + worldSize, meta.minX + meta.worldWidth);
    const bottom = Math.min(worldY + worldSize, meta.minY + meta.worldHeight);
    if (right <= left || bottom <= top) return;
    const scaleX = this.trackLayer.width / meta.worldWidth;
    const scaleY = this.trackLayer.height / meta.worldHeight;
    ctx.drawImage(
      this.trackLayer,
      (left - meta.minX) * scaleX,
      (top - meta.minY) * scaleY,
      (right - left) * scaleX,
      (bottom - top) * scaleY,
      left,
      top,
      right - left,
      bottom - top
    );
  }

  #releaseTrackTile(key, { recycle = false } = {}) {
    const tile = this.trackTiles.get(key) ?? null;
    if (!tile) return null;
    this.trackTiles.delete(key);
    this.trackTileEvictions += 1;
    if (!recycle) {
      tile.canvas.width = 1;
      tile.canvas.height = 1;
      tile.context = null;
    }
    return tile;
  }

  #evictOldestTrackTile(protectedKeys = null, options = {}) {
    let oldestKey = null;
    let oldestUse = Infinity;
    for (const [key, tile] of this.trackTiles) {
      if (protectedKeys?.has(key)) continue;
      if (tile.used < oldestUse) { oldestUse = tile.used; oldestKey = key; }
    }
    if (oldestKey == null) return null;
    return this.#releaseTrackTile(oldestKey, options);
  }

  #acquireTrackTileSlot(protectedKeys) {
    if (this.trackTiles.size < MAX_TRACK_TILES) return { allowed: true, recycledTile: null };
    const recycledTile = this.#evictOldestTrackTile(protectedKeys, { recycle: true });
    return { allowed: Boolean(recycledTile), recycledTile };
  }

  #drawHighResolutionTrackTiles(ctx, worldScale) {
    const bounds = this.#visibleTrackTileCoordinates(worldScale);
    const visible = this.visibleTrackEntries;
    let visibleCount = 0;
    for (let tileY = bounds.minTileY; tileY <= bounds.maxTileY; tileY += 1) {
      for (let tileX = bounds.minTileX; tileX <= bounds.maxTileX; tileX += 1) {
        const key = this.#trackTileKey(tileX, tileY);
        if (!this.trackTileCoverage.has(key)) continue;
        const centerX = (tileX + 0.5) * TRACK_TILE_WORLD_SIZE;
        const centerY = (tileY + 0.5) * TRACK_TILE_WORLD_SIZE;
        let entry = visible[visibleCount];
        if (!entry) entry = visible[visibleCount] = {};
        entry.tileX = tileX;
        entry.tileY = tileY;
        entry.key = key;
        entry.distance = Math.hypot(centerX - this.camera.x, centerY - this.camera.y);
        visibleCount += 1;
      }
    }
    visible.length = visibleCount;
    this.trackVisibleTiles = visibleCount;
    const generationBudget = this.frameCostEma > 20 && this.trackTiles.size > 0 ? 0 : MAX_NEW_TILES_PER_FRAME;
    if (generationBudget > 0 && visible.some((entry) => !this.trackTiles.has(entry.key))) {
      visible.sort((a, b) => a.distance - b.distance);
    }
    const retainedKeys = this.retainedTrackTileKeys;
    retainedKeys.clear();
    let generated = 0;
    let fallbackCount = 0;
    for (const entry of visible) {
      let tile = this.trackTiles.get(entry.key);
      if (tile) this.trackTileHits += 1;
      else {
        this.trackTileMisses += 1;
        if (generated < generationBudget) {
          const slot = this.#acquireTrackTileSlot(retainedKeys);
          if (slot.allowed) {
            tile = this.#createTrackTile(entry.tileX, entry.tileY, slot.recycledTile);
            if (tile) {
              this.trackTiles.set(entry.key, tile);
              generated += 1;
            }
          }
        }
      }
      if (!tile) {
        this.#drawTrackLayerRegion(ctx, entry.tileX * TRACK_TILE_WORLD_SIZE, entry.tileY * TRACK_TILE_WORLD_SIZE, TRACK_TILE_WORLD_SIZE);
        fallbackCount += 1;
        continue;
      }
      tile.used = ++this.trackTileUseCounter;
      retainedKeys.add(entry.key);
      const sourceOffset = TRACK_TILE_BLEED * TRACK_TILE_SCALE;
      const sourceSize = TRACK_TILE_WORLD_SIZE * TRACK_TILE_SCALE;
      const overlapWorld = TRACK_TILE_OVERLAP_PX / TRACK_TILE_SCALE;
      ctx.drawImage(
        tile.canvas,
        sourceOffset - TRACK_TILE_OVERLAP_PX,
        sourceOffset - TRACK_TILE_OVERLAP_PX,
        sourceSize + TRACK_TILE_OVERLAP_PX * 2,
        sourceSize + TRACK_TILE_OVERLAP_PX * 2,
        tile.coreX - overlapWorld,
        tile.coreY - overlapWorld,
        TRACK_TILE_WORLD_SIZE + overlapWorld * 2,
        TRACK_TILE_WORLD_SIZE + overlapWorld * 2
      );
    }
    this.trackTileFallbacks = fallbackCount;
  }


  #updateCamera(focus, dt) {
    const rawSpeed = Math.hypot(focus.vx, focus.vy);
    const speedFactor = smoothingFactor(dt, 0.16);
    this.camera.speed += (rawSpeed - this.camera.speed) * speedFactor;
    const speed = this.camera.speed;
    const headingFactor = smoothingFactor(dt, this.cameraMode === "chase" ? 0.14 : 0.09);
    this.camera.heading += angleDelta(focus.angle, this.camera.heading) * headingFactor;

    let targetX = focus.x;
    let targetY = focus.y;
    let targetZoom;
    let targetRotation;

    if (this.cameraMode === "chase") {
      const lookAhead = clamp(175 + speed * 0.38, 175, 345);
      const prediction = clamp(speed / 3000, 0.025, 0.12);
      targetX += focus.vx * prediction + Math.cos(this.camera.heading) * lookAhead;
      targetY += focus.vy * prediction + Math.sin(this.camera.heading) * lookAhead;
      targetZoom = clamp(0.76 - speed / 2550, 0.55, 0.74);
      targetRotation = -Math.PI / 2 - this.camera.heading;
    } else {
      targetZoom = clamp(0.87 - speed / 1700, 0.58, 0.85);
      targetRotation = 0;
    }

    const distance = Math.hypot(targetX - this.camera.x, targetY - this.camera.y);
    if (!this.camera.initialized || distance > 720) {
      this.camera.x = targetX;
      this.camera.y = targetY;
      this.camera.zoom = targetZoom;
      this.camera.rotation = targetRotation;
      this.camera.initialized = true;
      return;
    }

    const positionFactor = smoothingFactor(dt, this.cameraMode === "chase" ? 0.16 : 0.11);
    const zoomFactor = smoothingFactor(dt, 0.30);
    const rotationFactor = smoothingFactor(dt, this.cameraMode === "chase" ? 0.18 : 0.13);
    this.camera.x += (targetX - this.camera.x) * positionFactor;
    this.camera.y += (targetY - this.camera.y) * positionFactor;
    this.camera.zoom += (targetZoom - this.camera.zoom) * zoomFactor;
    this.camera.rotation += angleDelta(targetRotation, this.camera.rotation) * rotationFactor;
  }

  #draw(now) {
    const rawDt = clamp((now - this.lastDrawAt) / 1000, 1 / 240, 0.05);
    this.lastDrawAt = now;
    // Exponential camera smoothing is time based. Feeding it a fixed nominal
    // step made 27-42 ms presentation gaps visibly slow the camera, then speed it
    // up again. Use real elapsed time, capped at 50 ms after a genuine long stall.
    const presentationDt = rawDt;
    this.cameraRawDtMs = rawDt * 1000;
    this.cameraStepMs = presentationDt * 1000;
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    let snapshot = this.#interpolatedSnapshot(now);
    if (!this.simulationFrame || this.smoothAuthoritativePresentation) {
      snapshot = this.#smoothNetworkSnapshot(snapshot, presentationDt);
    }
    if (!this.simulationFrame) {
      snapshot = this.#applyLocalPrediction(snapshot, now, rawDt);
    }
    snapshot = this.#stabilizeRaceOrder(snapshot, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.background.width === width && this.background.height === height) ctx.drawImage(this.background, 0, 0);
    else {
      ctx.fillStyle = "#12100e";
      ctx.fillRect(0, 0, width, height);
    }

    if (!snapshot) {
      ctx.fillStyle = "#d7c7a1";
      ctx.font = `${Math.round(height * 0.035)}px serif`;
      ctx.textAlign = "center";
      ctx.fillText("Ожидание данных гонки…", width / 2, height / 2);
      return;
    }

    let focus = snapshot.cars.find((car) => car.id === this.localCarId) ?? null;
    if (!focus) {
      for (const car of snapshot.cars) if (!focus || car.place < focus.place) focus = car;
    }
    if (focus) this.#updateCamera(focus, presentationDt);

    const worldScale = this.camera.zoom * this.outputScale;
    ctx.translate(width / 2, height / 2);
    ctx.rotate(this.camera.rotation);
    ctx.scale(worldScale, worldScale);
    ctx.translate(-this.camera.x, -this.camera.y);

    this.#drawTrack(ctx, worldScale);
    this.#drawCars(ctx, snapshot.cars, now);

    // All text/UI is drawn in screen space. It is never rotated or scaled by the
    // world matrix, so glyph rasterization remains stable while the camera turns.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.#drawCarLabels(ctx, snapshot.cars, width, height, worldScale);
    if (this.minimapEnabled) this.#drawMinimap(ctx, snapshot.cars, width, height);
    if (focus) this.#drawRaceHud(ctx, focus, snapshot, width, height);
    this.#drawCountdown(ctx, snapshot, width, height);
    if (this.performanceOverlay) this.#drawPerformanceOverlay(ctx, width, height);

    if (focus && this.onHud) this.onHud(focus, snapshot);
  }

  #drawTrack(ctx, worldScale) {
    const meta = this.trackLayerMeta;
    if (!meta || !this.trackLayer.width || !this.trackLayer.height) {
      // Exceptional fallback for a lost backing store. The normal race loop
      // never repaints the complete vector circuit frame after frame.
      this.trackRenderMode = "vector-fallback";
      this.#paintStaticTrack(ctx);
      return;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (worldScale <= meta.layerScale * 1.08) {
      this.trackRenderMode = "bitmap";
      this.trackVisibleTiles = 0;
      this.trackTileFallbacks = 0;
      ctx.drawImage(this.trackLayer, meta.minX, meta.minY, meta.worldWidth, meta.worldHeight);
    } else {
      this.trackRenderMode = "tiles";
      this.#drawHighResolutionTrackTiles(ctx, worldScale);
    }
    ctx.restore();
  }

  #paintStaticTrack(ctx) {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Runoff is a true variable-width ribbon. Near the finish line and through
    // the committed pit lane its width collapses to zero, so the same perimeter
    // wall visibly converges onto the asphalt edge.
    const surfaceFills = {
      grass: "#45552f",
      sand: "#a88a58",
      gravel: "#706d64"
    };
    for (const type of ["grass", "sand", "gravel"]) {
      ctx.fillStyle = surfaceFills[type];
      ctx.fill(this.runoffSurfacePaths?.[type] ?? new Path2D());
      ctx.fill(this.pitRunoffSurfacePaths?.[type] ?? new Path2D());
    }
    this.#drawRunoffTextures(ctx);

    // Paint the branch first. Its shared beginning is hidden by the main road;
    // as the centreline separates, the pit lane appears as a gradual fork.
    if (this.track.pit?.samples?.length) {
      ctx.strokeStyle = "#756d5d";
      ctx.lineWidth = this.track.pit.width + 8;
      ctx.stroke(this.pitPath);
      ctx.strokeStyle = "#9b927f";
      ctx.lineWidth = this.track.pit.width;
      ctx.stroke(this.pitPath);
      ctx.strokeStyle = "rgba(238, 221, 167, 0.68)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 12]);
      ctx.stroke(this.pitPath);
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = "#5c5246";
    ctx.lineWidth = this.track.width + 10;
    ctx.stroke(this.trackPath);
    ctx.strokeStyle = "#b09a72";
    ctx.lineWidth = this.track.width;
    ctx.stroke(this.trackPath);
    ctx.strokeStyle = "rgba(54, 41, 28, 0.34)";
    ctx.lineWidth = 3;
    ctx.setLineDash([18, 22]);
    ctx.stroke(this.trackPath);
    ctx.setLineDash([]);

    // The circuit-side wall opens exactly where the pit branch diverges and
    // rejoins. The outer pit wall replaces it continuously; the inner pit wall
    // fades in only after a real median exists, eliminating floating rail ends.
    for (const geometry of this.wallGeometry ?? []) this.#drawBoundaryWallGeometry(ctx, geometry);

    if (this.track.pit?.samples?.length) {
      const service = this.track.pit.samples[this.track.pit.serviceIndex];
      ctx.save();
      ctx.translate(service.x, service.y);
      ctx.rotate(Math.atan2(service.ty, service.tx));
      const serviceHalfLength = Number(this.track.pit.serviceHalfLength ?? 52);
      ctx.fillStyle = "rgba(38, 118, 137, 0.45)";
      ctx.fillRect(-serviceHalfLength, -this.track.pit.width * 0.48, serviceHalfLength * 2, this.track.pit.width * 0.96);
      ctx.strokeStyle = "rgba(144, 230, 247, 0.85)";
      ctx.lineWidth = 3;
      ctx.strokeRect(-serviceHalfLength, -this.track.pit.width * 0.48, serviceHalfLength * 2, this.track.pit.width * 0.96);
      ctx.restore();
    }

    // Solid scenery is deliberately painted after every fence layer. A building,
    // tree crown or column therefore masks a rail behind it instead of being cut
    // in half by a fence drawn later in the static pass.
    this.#drawScenery(ctx);

    const start = this.track.samples[0];
    const half = this.track.width * 0.48;
    const squares = 10;
    const squareWidth = (half * 2) / squares;
    for (let i = 0; i < squares; i += 1) {
      const offset = -half + squareWidth * (i + 0.5);
      ctx.fillStyle = i % 2 === 0 ? "#eee4cb" : "#2a2621";
      ctx.save();
      ctx.translate(start.x + start.nx * offset, start.y + start.ny * offset);
      ctx.rotate(Math.atan2(start.ty, start.tx));
      ctx.fillRect(-7, -squareWidth / 2, 14, squareWidth);
      ctx.restore();
    }
  }

  #drawScenery(ctx) {
    const obstacles = this.track.scenery ?? [];
    if (!obstacles.length) return;
    const drawRoof = (ctx, width, height, roof, wall) => {
      ctx.fillStyle = "rgba(12, 10, 8, 0.28)";
      ctx.fillRect(-width * 0.48 + 5, -height * 0.48 + 7, width * 0.96, height * 0.96);
      ctx.fillStyle = wall;
      ctx.fillRect(-width * 0.5, -height * 0.5, width, height);
      ctx.strokeStyle = "rgba(35, 27, 21, 0.85)";
      ctx.lineWidth = 3;
      ctx.strokeRect(-width * 0.5, -height * 0.5, width, height);
      ctx.fillStyle = roof;
      ctx.beginPath();
      ctx.moveTo(-width * 0.56, -height * 0.08);
      ctx.lineTo(0, -height * 0.62);
      ctx.lineTo(width * 0.56, -height * 0.08);
      ctx.lineTo(width * 0.56, height * 0.18);
      ctx.lineTo(0, -height * 0.34);
      ctx.lineTo(-width * 0.56, height * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };

    for (const obstacle of obstacles) {
      const scale = Math.max(0.4, Number(obstacle.scale) || 1);
      const width = Math.max(12, Number(obstacle.width) || Number(obstacle.visualRadius) * 1.5 || 24);
      const height = Math.max(12, Number(obstacle.height) || Number(obstacle.visualRadius) * 1.5 || 24);
      const visualRadius = Math.max(9, Number(obstacle.visualRadius) || 18);
      ctx.save();
      ctx.translate(obstacle.x, obstacle.y);
      ctx.rotate(Number(obstacle.angle) || 0);
      ctx.fillStyle = "rgba(7, 6, 5, 0.28)";
      ctx.beginPath();
      ctx.ellipse(5, 8, visualRadius * 0.92, visualRadius * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();

      switch (obstacle.kind) {
        case "tree":
        case "pine": {
          const pine = obstacle.kind === "pine";
          ctx.fillStyle = "#4b3525";
          ctx.strokeStyle = "#211711";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(6, Number(obstacle.collisionRadius) * 0.48), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          const crown = visualRadius * (pine ? 0.92 : 1);
          const crownColors = pine ? ["#203c2b", "#31573a", "#496947"] : ["#2d4b2d", "#45643a", "#60764a"];
          for (let index = 0; index < 3; index += 1) {
            const angle = index / 3 * Math.PI * 2 + scale;
            ctx.fillStyle = crownColors[index];
            ctx.beginPath();
            ctx.arc(Math.cos(angle) * crown * 0.28, Math.sin(angle) * crown * 0.24, crown * (0.55 - index * 0.035), 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.strokeStyle = "rgba(22, 31, 20, 0.72)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, crown * 0.82, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "column":
        case "obelisk": {
          const obelisk = obstacle.kind === "obelisk";
          ctx.fillStyle = "#77766e";
          ctx.strokeStyle = "#343531";
          ctx.lineWidth = 3;
          if (obelisk) {
            ctx.beginPath();
            ctx.moveTo(0, -visualRadius);
            ctx.lineTo(visualRadius * 0.58, visualRadius * 0.72);
            ctx.lineTo(-visualRadius * 0.58, visualRadius * 0.72);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, visualRadius * 0.72, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.strokeStyle = "rgba(223, 218, 197, 0.56)";
            ctx.lineWidth = 2;
            for (let index = -2; index <= 2; index += 1) {
              ctx.beginPath();
              ctx.moveTo(index * visualRadius * 0.18, -visualRadius * 0.48);
              ctx.lineTo(index * visualRadius * 0.18, visualRadius * 0.48);
              ctx.stroke();
            }
          }
          break;
        }
        case "statue": {
          ctx.fillStyle = "#626b67";
          ctx.strokeStyle = "#272d2b";
          ctx.lineWidth = 3;
          ctx.fillRect(-visualRadius * 0.72, -visualRadius * 0.72, visualRadius * 1.44, visualRadius * 1.44);
          ctx.strokeRect(-visualRadius * 0.72, -visualRadius * 0.72, visualRadius * 1.44, visualRadius * 1.44);
          ctx.fillStyle = "#8b9189";
          ctx.beginPath();
          ctx.arc(0, -visualRadius * 0.18, visualRadius * 0.31, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillRect(-visualRadius * 0.18, 0, visualRadius * 0.36, visualRadius * 0.58);
          break;
        }
        case "boulder": {
          ctx.fillStyle = "#5d5a50";
          ctx.strokeStyle = "#282720";
          ctx.lineWidth = 3;
          ctx.beginPath();
          for (let index = 0; index < 9; index += 1) {
            const angle = index / 9 * Math.PI * 2;
            const radius = visualRadius * (0.76 + 0.16 * Math.sin(index * 2.31 + scale * 4));
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = "rgba(187, 181, 154, 0.36)";
          ctx.beginPath();
          ctx.moveTo(-visualRadius * 0.35, -visualRadius * 0.26);
          ctx.lineTo(visualRadius * 0.28, visualRadius * 0.12);
          ctx.stroke();
          break;
        }
        case "house":
          drawRoof(ctx, width, height, "#695043", "#a28c6a");
          break;
        case "barn":
          drawRoof(ctx, width, height, "#6c3c31", "#8b684f");
          ctx.fillStyle = "#33251d";
          ctx.fillRect(-width * 0.13, height * 0.08, width * 0.26, height * 0.42);
          break;
        case "workshop":
          drawRoof(ctx, width, height, "#4e5556", "#716f66");
          ctx.fillStyle = "#252b2c";
          ctx.fillRect(width * 0.18, -height * 0.62, width * 0.14, height * 0.28);
          break;
        case "tank": {
          ctx.fillStyle = "#62645d";
          ctx.strokeStyle = "#272925";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, 0, visualRadius * 0.82, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = "rgba(210, 207, 183, 0.44)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, visualRadius * 0.48, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "tower":
        case "timingTower": {
          ctx.fillStyle = obstacle.kind === "timingTower" ? "#665a49" : "#777269";
          ctx.strokeStyle = "#292722";
          ctx.lineWidth = 3;
          ctx.fillRect(-width * 0.46, -height * 0.5, width * 0.92, height);
          ctx.strokeRect(-width * 0.46, -height * 0.5, width * 0.92, height);
          ctx.fillStyle = "#252a2d";
          for (let row = -1; row <= 1; row += 1) {
            ctx.fillRect(-width * 0.24, row * height * 0.22 - height * 0.07, width * 0.48, height * 0.12);
          }
          break;
        }
        case "grandstand": {
          ctx.fillStyle = "#5f5548";
          ctx.strokeStyle = "#28231e";
          ctx.lineWidth = 3;
          ctx.fillRect(-width * 0.5, -height * 0.5, width, height);
          ctx.strokeRect(-width * 0.5, -height * 0.5, width, height);
          for (let row = 0; row < 5; row += 1) {
            ctx.strokeStyle = row % 2 ? "#9f8e69" : "#40372e";
            ctx.lineWidth = 3;
            const y = -height * 0.36 + row * height * 0.18;
            ctx.beginPath();
            ctx.moveTo(-width * 0.42, y);
            ctx.lineTo(width * 0.42, y);
            ctx.stroke();
          }
          break;
        }
        default:
          ctx.fillStyle = "#68635a";
          ctx.beginPath();
          ctx.arc(0, 0, visualRadius * 0.72, 0, Math.PI * 2);
          ctx.fill();
      }
      ctx.restore();
    }
  }

  #drawCars(ctx, cars, now) {
    // Preserve the local-car-on-top rule without allocating and sorting a new
    // car array every frame.
    let local = null;
    for (const car of cars) {
      if (car.id === this.localCarId) local = car;
      else this.#drawCar(ctx, car, now);
    }
    if (local) this.#drawCar(ctx, local, now);
  }

  #drawCar(ctx, car, now) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    if (car.id === this.localCarId) {
      ctx.fillStyle = "rgba(255, 236, 164, 0.14)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 31, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (car.boost && !car.disabled) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.026 + car.x * 0.01);
      const length = 40 + pulse * 11;
      ctx.fillStyle = "rgba(75, 205, 243, 0.46)";
      ctx.beginPath();
      ctx.moveTo(-15, -9);
      ctx.lineTo(-15 - length, 0);
      ctx.lineTo(-15, 9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(184, 246, 255, 0.88)";
      ctx.beginPath();
      ctx.moveTo(-14, -4);
      ctx.lineTo(-35 - pulse * 8, 0);
      ctx.lineTo(-14, 4);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = car.disabled ? "#393633" : car.color;
    ctx.strokeStyle = car.ram ? "#fff0aa" : "#171411";
    ctx.lineWidth = car.ram ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(24, 0);
    ctx.lineTo(9, -13);
    ctx.lineTo(-15, -12);
    ctx.lineTo(-23, -6);
    ctx.lineTo(-23, 6);
    ctx.lineTo(-15, 12);
    ctx.lineTo(9, 13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = car.heat > 82 ? "#ff754d" : "#a8ebff";
    ctx.beginPath();
    ctx.arc(-1, 0, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#15120f";
    ctx.fillRect(-12, -15, 8, 5);
    ctx.fillRect(9, -15, 8, 5);
    ctx.fillRect(-12, 10, 8, 5);
    ctx.fillRect(9, 10, 8, 5);
    ctx.restore();
  }




  #drawCarLabels(ctx, cars, width, height, worldScale) {
    const verticalOffset = 31 * this.outputScale;
    const cos = Math.cos(this.camera.rotation);
    const sin = Math.sin(this.camera.rotation);
    for (const car of cars) {
      const dx = car.x - this.camera.x;
      const dy = car.y - this.camera.y;
      const screenX = width * 0.5 + (dx * cos - dy * sin) * worldScale;
      const screenY = height * 0.5 + (dx * sin + dy * cos) * worldScale;
      if (screenX < -180 || screenX > width + 180 || screenY < -80 || screenY > height + 80) continue;
      const sprite = this.#getLabelSprite(car.id, car.name, car.id === this.localCarId);
      // The glyphs are already rasterized in a cached sprite. Snapping the whole
      // sprite to integer pixels made its motion visibly step at low chase zoom.
      // Fractional placement keeps the label attached to the interpolated car.
      const x = screenX - sprite.canvas.width * 0.5;
      const y = screenY - verticalOffset - sprite.canvas.height;
      ctx.drawImage(sprite.canvas, x, y);
      ctx.font = sprite.font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = sprite.textColor;
      ctx.fillText(`${car.place}.`, x + sprite.placeCenterX, y + sprite.canvas.height * 0.5 + 0.5);
    }
  }

  #getLabelSprite(carId, name, local) {
    const safeName = String(name || "Болид");
    const key = `${this.outputScale.toFixed(3)}:${local ? 1 : 0}:${String(carId)}:${safeName}`;
    const cached = this.labelCache.get(key);
    if (cached) {
      // Map insertion order is used as an actual LRU queue.
      this.labelCache.delete(key);
      this.labelCache.set(key, cached);
      this.labelCacheHits += 1;
      return cached;
    }
    this.labelCacheMisses += 1;

    const scale = this.outputScale;
    const fontSize = Math.max(11, Math.round(12 * scale));
    const paddingX = Math.round(7 * scale);
    const paddingY = Math.round(4 * scale);
    const scratch = document.createElement("canvas");
    const measure = scratch.getContext("2d");
    const font = `700 ${fontSize}px system-ui, sans-serif`;
    measure.font = font;
    const nameWidth = Math.ceil(measure.measureText(safeName).width);
    const placeWidth = Math.ceil(measure.measureText("12.").width) + Math.round(4 * scale);
    scratch.width = nameWidth + placeWidth + paddingX * 2;
    scratch.height = fontSize + paddingY * 2 + Math.round(2 * scale);

    const ctx = scratch.getContext("2d");
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.#roundedRect(ctx, 0.5, 0.5, scratch.width - 1, scratch.height - 1, Math.round(6 * scale));
    ctx.fillStyle = local ? "rgba(21, 39, 44, 0.92)" : "rgba(13, 17, 19, 0.86)";
    ctx.fill();
    ctx.strokeStyle = local ? "rgba(99, 198, 220, 0.90)" : "rgba(133, 145, 149, 0.62)";
    ctx.lineWidth = Math.max(1, Math.round(scale));
    ctx.stroke();
    const textColor = local ? "#effcff" : "#eee7d7";
    ctx.fillStyle = textColor;
    const nameCenterX = paddingX + placeWidth + nameWidth * 0.5;
    ctx.fillText(safeName, nameCenterX, scratch.height * 0.5 + 0.5);
    const sprite = {
      canvas: scratch,
      font,
      textColor,
      placeCenterX: paddingX + placeWidth * 0.5
    };
    this.labelCache.set(key, sprite);
    if (this.labelCache.size > MAX_LABEL_CACHE) {
      const oldestKey = this.labelCache.keys().next().value;
      const oldest = this.labelCache.get(oldestKey);
      if (oldest && oldest !== sprite) {
        oldest.canvas.width = 1;
        oldest.canvas.height = 1;
      }
      this.labelCache.delete(oldestKey);
    }
    return sprite;
  }

  #roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width * 0.5, height * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  #drawMinimap(ctx, cars, width, height) {
    const projection = this.minimapProjection;
    if (!projection) return;
    const s = this.outputScale;
    const margin = Math.round(14 * s);
    const x = width - projection.boxWidth - margin;
    const y = height - projection.boxHeight - margin;
    ctx.drawImage(this.minimapLayer, x, y);

    for (const car of cars) {
      let marker;
      if (car.pitState && car.pitState !== "track" && this.track.pit?.samples?.length) {
        marker = pointAtPitProgress(this.track, Number(car.pitProgress) || 0);
      } else {
        marker = pointAtTrackProgress(this.track, Number(car.progress) || 0);
      }
      const px = x + projection.originX + marker.x * projection.mapScale;
      const py = y + projection.originY + marker.y * projection.mapScale;
      ctx.beginPath();
      ctx.arc(px, py, car.id === this.localCarId ? 4.5 * s : 3.2 * s, 0, Math.PI * 2);
      ctx.fillStyle = car.disabled ? "#555" : car.color;
      ctx.fill();
      if (car.id === this.localCarId) {
        ctx.strokeStyle = "#eafaff";
        ctx.lineWidth = Math.max(1.5, 1.5 * s);
        ctx.stroke();
      }
    }
  }

  #raceHudStatus(car) {
    if (car.finishBlocked) return "Финиш закрыт: выполните обязательный пит-стоп";
    if (car.pitState === "entering") return car.pitInServiceZone
      ? "Голубая зона: полностью остановите болид"
      : "Пит-лейн · ограничение 60 км/ч · остановитесь в голубой зоне";
    if (car.pitState === "exit") return "Пит-лейн · ограничение 60 км/ч";
    if (car.temporaryAutopilot) return "Временный автопилот";
    if (car.overheated) return "Ядро перегрето";
    const angle = Number(car.angle) || 0;
    const forwardX = Math.cos(angle);
    const forwardY = Math.sin(angle);
    const rightX = -forwardY;
    const rightY = forwardX;
    const vx = Number(car.vx) || 0;
    const vy = Number(car.vy) || 0;
    const forwardSpeed = vx * forwardX + vy * forwardY;
    const lateralSpeed = vx * rightX + vy * rightY;
    const slipDegrees = Math.abs(Math.atan2(lateralSpeed, Math.max(22, Math.abs(forwardSpeed)))) * 180 / Math.PI;
    const speedKmh = Math.hypot(vx, vy) * (0.62 / 3);
    const driftAmount = Number(car.driftAmount) || 0;
    if (speedKmh > 70 && driftAmount > 0.18 && slipDegrees >= 14) {
      return slipDegrees >= 34 ? "Срыв заноса: контррулите и отпустите газ" : `Управляемый занос · ${Math.round(slipDegrees)}°`;
    }
    return "";
  }

  #drawHudPanel(ctx, x, y, width, height, label, value, { valueColor = "#f2f6f7", valueSize = 16 } = {}) {
    const s = this.outputScale;
    this.#roundedRect(ctx, x, y, width, height, 8 * s);
    ctx.fillStyle = "rgba(12, 18, 21, 0.86)";
    ctx.fill();
    ctx.strokeStyle = "rgba(113, 145, 157, 0.45)";
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#94a7ae";
    ctx.font = `800 ${Math.max(9, Math.round(9 * s))}px system-ui, sans-serif`;
    ctx.fillText(label.toUpperCase(), x + 10 * s, y + 7 * s);
    ctx.fillStyle = valueColor;
    ctx.font = `700 ${Math.max(12, Math.round(valueSize * s))}px system-ui, sans-serif`;
    ctx.fillText(String(value), x + 10 * s, y + 21 * s);
  }

  #drawHudMeter(ctx, x, y, width, height, label, ratio, { kind = "charge", warning = false, critical = false, empty = false } = {}) {
    const s = this.outputScale;
    this.#roundedRect(ctx, x, y, width, height, 8 * s);
    ctx.fillStyle = empty ? "rgba(58, 24, 20, 0.90)" : "rgba(12, 18, 21, 0.86)";
    ctx.fill();
    ctx.strokeStyle = critical ? "rgba(239, 91, 62, 0.90)" : warning ? "rgba(236, 171, 72, 0.78)" : "rgba(113, 145, 157, 0.45)";
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = empty ? "#f1a69c" : "#94a7ae";
    ctx.font = `800 ${Math.max(9, Math.round(9 * s))}px system-ui, sans-serif`;
    ctx.fillText(label.toUpperCase(), x + 9 * s, y + 6 * s);
    const barX = x;
    const barY = y + height - 5 * s;
    const barWidth = width * clamp(Number(ratio) || 0, 0, 1);
    if (barWidth <= 0) return;
    ctx.fillStyle = kind === "health"
      ? "#c55e52"
      : kind === "heat" || critical || warning
        ? "#dc7440"
        : "#55bfd4";
    ctx.fillRect(barX, barY, barWidth, 5 * s);
  }

  #drawRaceHud(ctx, car, snapshot, width, height) {
    const s = this.outputScale;
    const margin = 14 * s;
    const compact = width / s < 920;
    const panelHeight = (compact ? 47 : 50) * s;
    const gap = 7 * s;
    const panelWidth = (compact ? 76 : 86) * s;
    const timingWidth = (compact ? 88 : 102) * s;

    ctx.save();
    const raceValues = [
      ["Место", `${car.place} / ${snapshot.cars.length}`],
      ["Круг", `${Math.min(Number(car.lap || 0) + 1, Number(snapshot.laps) || 1)} / ${snapshot.laps}`],
      ["Пит-стопы", `${car.pitStopsCompleted ?? 0} / ${car.pitStopsRequired ?? snapshot.requiredPitStops ?? 0}`],
      ["Время", formatRaceTime(Number(snapshot.time))]
    ];
    for (let index = 0; index < raceValues.length; index += 1) {
      const [label, value] = raceValues[index];
      this.#drawHudPanel(ctx, margin + index * (panelWidth + gap), margin, panelWidth, panelHeight, label, value, {
        valueSize: compact ? 13 : 15
      });
    }

    const timingY = margin + panelHeight + gap;
    const timingValues = [
      ["Текущий круг", formatRaceTime(Number(car.currentLapTime))],
      ["Последний", formatRaceTime(Number(car.lastLapTime))],
      ["Лучший", formatRaceTime(Number(car.bestLapTime))]
    ];
    for (let index = 0; index < timingValues.length; index += 1) {
      const [label, value] = timingValues[index];
      this.#drawHudPanel(ctx, margin + index * (timingWidth + gap), timingY, timingWidth, panelHeight, label, value, {
        valueSize: compact ? 11 : 13
      });
    }

    const vehicleWidth = (compact ? 184 : 210) * s;
    const vehicleX = width - margin - vehicleWidth;
    const speedKmh = Math.round(Math.hypot(Number(car.vx) || 0, Number(car.vy) || 0) * (0.62 / 3));
    this.#drawHudPanel(ctx, vehicleX, margin, vehicleWidth, 55 * s, "Скорость", `${speedKmh} км/ч`, {
      valueColor: "#f5d985",
      valueSize: compact ? 17 : 20
    });
    const meterHeight = 31 * s;
    const meterGap = 7 * s;
    let meterY = margin + 55 * s + meterGap;
    this.#drawHudMeter(ctx, vehicleX, meterY, vehicleWidth, meterHeight, "Прочность", Number(car.health) / Math.max(1, Number(car.maxHealth) || 1), { kind: "health" });
    meterY += meterHeight + meterGap;
    const chargeEmpty = Number(car.charge) <= 0.01;
    this.#drawHudMeter(ctx, vehicleX, meterY, vehicleWidth, meterHeight, chargeEmpty ? "Заряд исчерпан" : "Заряд", Number(car.charge) / Math.max(1, Number(car.maxCharge) || 1), { kind: "charge", empty: chargeEmpty });
    meterY += meterHeight + meterGap;
    const warningAt = car.heatWarning ? 68 : 78;
    this.#drawHudMeter(ctx, vehicleX, meterY, vehicleWidth, meterHeight, car.overheated ? "Перегрев · блокировка" : Number(car.heat) >= warningAt ? "Опасный нагрев" : "Нагрев", Number(car.heat) / 100, {
      kind: "heat",
      warning: Number(car.heat) >= warningAt,
      critical: Boolean(car.overheated) || Number(car.heat) >= 100
    });

    const status = this.#raceHudStatus(car);
    if (status) {
      ctx.font = `750 ${Math.max(10, Math.round(11 * s))}px system-ui, sans-serif`;
      const paddingX = 13 * s;
      const statusWidth = Math.min(width - 32 * s, ctx.measureText(status).width + paddingX * 2);
      const statusHeight = 34 * s;
      const statusX = (width - statusWidth) * 0.5;
      const statusY = 116 * s;
      this.#roundedRect(ctx, statusX, statusY, statusWidth, statusHeight, 8 * s);
      ctx.fillStyle = "rgba(48, 31, 15, 0.93)";
      ctx.fill();
      ctx.strokeStyle = "rgba(218, 154, 72, 0.62)";
      ctx.lineWidth = Math.max(1, s);
      ctx.stroke();
      ctx.fillStyle = "#ffe3a4";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(status, width * 0.5, statusY + statusHeight * 0.5);
    }
    ctx.restore();
  }

  #drawCountdown(ctx, snapshot, width, height) {
    if (snapshot.countdown > 0) {
      const value = Math.ceil(snapshot.countdown);
      ctx.fillStyle = "rgba(9, 7, 5, 0.6)";
      ctx.fillRect(0, 0, width, height);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.floor(Math.min(width, height) * 0.22)}px serif`;
      ctx.fillStyle = "#f2d77f";
      ctx.strokeStyle = "#301b0d";
      ctx.lineWidth = 10;
      ctx.strokeText(String(value), width / 2, height / 2);
      ctx.fillText(String(value), width / 2, height / 2);
    } else if (snapshot.started && snapshot.time < 1.1) {
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.font = `900 ${Math.floor(Math.min(width, height) * 0.13)}px serif`;
      ctx.fillStyle = "#f2d77f";
      ctx.strokeStyle = "#301b0d";
      ctx.lineWidth = 8;
      ctx.strokeText("ВПЕРЁД", width / 2, height * 0.42);
      ctx.fillText("ВПЕРЁД", width / 2, height * 0.42);
    }
  }

  #drawPerformanceOverlay(ctx, width, height) {
    const stats = this.getPerformanceStats();
    const s = this.outputScale;
    const fontSize = Math.max(10, Math.round(11 * s));
    const lineHeight = Math.round(fontSize * 1.35);
    const padding = Math.round(8 * s);
    const lines = [
      `FPS ${stats.fps.toFixed(1)} / ${stats.effectiveTargetFps.toFixed(1)} · display ${stats.displayRefreshHz.toFixed(0)} Hz ÷${stats.renderDivisor}`,
      `Render ${stats.renderMs.toFixed(2)} · p95 ${stats.renderP95.toFixed(2)} · max ${stats.renderMax.toFixed(2)} ms`,
      `Frame p50 ${stats.renderIntervalP50.toFixed(1)} · p95 ${stats.renderIntervalP95.toFixed(1)} · max ${stats.renderIntervalMax.toFixed(1)} ms`,
      `RAF p50 ${stats.rafP50.toFixed(1)} · p95 ${stats.rafP95.toFixed(1)} · max ${stats.rafMax.toFixed(1)} ms`,
      `RAF stalls >25/${stats.rafLong25} · >40/${stats.rafLong40} · >80/${stats.rafLong80}`,
      `Long tasks ${stats.longTaskCount} · p95 ${stats.longTaskP95.toFixed(1)} · max ${stats.longTaskMax.toFixed(1)} ms`,
      `Snapshot ${stats.snapshotMs.toFixed(1)} ms · Delivery ${stats.deliverySource} ${stats.deliveryMs.toFixed(1)} / p95 ${stats.deliveryP95.toFixed(1)}`,
      `Prediction ${stats.predictionError.toFixed(1)} px · correction ${stats.predictionCorrection.toFixed(1)}${stats.predictionBlocked ? " · BLOCK" : ""}`,
      `Camera dt ${stats.cameraStepMs.toFixed(1)} / raw ${stats.cameraRawDtMs.toFixed(1)} ms · auth smooth ${stats.authoritativeSmoothing ? "yes" : "no"}`,
      `Labels ${stats.labelCacheSize}/${MAX_LABEL_CACHE} · hit ${(stats.labelCacheHitRate * 100).toFixed(0)}%`,
      `Track ${stats.trackRenderMode} · tiles ${stats.trackTileCacheSize}/${MAX_TRACK_TILES} · visible ${stats.trackVisibleTiles}`,
      `Tile hit ${(stats.trackTileHitRate * 100).toFixed(0)}% · gen ${stats.trackTileGenerationRate.toFixed(1)}/s · fallback ${stats.trackTileFallbacks}`,
      `Tile canvas alloc ${stats.trackTileAllocations} · reuse ${stats.trackTileReuses} · evict ${stats.trackTileEvictions}`
    ];
    ctx.save();
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    const boxWidth = Math.min(width - padding * 2, Math.max(...lines.map((line) => ctx.measureText(line).width)) + padding * 2);
    const boxHeight = lines.length * lineHeight + padding * 2;
    const x = padding;
    const y = height - boxHeight - padding;
    ctx.fillStyle = "rgba(8, 11, 12, 0.82)";
    this.#roundedRect(ctx, x, y, boxWidth, boxHeight, Math.round(6 * s));
    ctx.fill();
    ctx.strokeStyle = "rgba(119, 202, 220, 0.58)";
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();
    ctx.fillStyle = "#d9f4f7";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let index = 0; index < lines.length; index += 1) {
      ctx.fillText(lines[index], x + padding, y + padding + index * lineHeight);
    }
    ctx.restore();
  }
}
