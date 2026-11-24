/**
 * Deterministic pier-walk clock shared by the Node room and canvas client.
 *
 * The canvas never invents an authoritative elapsed time. Render frames and
 * catch-up work are re-synchronised to the room snapshot. Tick math uses an
 * exact rational grid (60 Hz => 50/3 ms per tick) to avoid 1-ULP boundary
 * disagreements that previously left the canvas a permanent 2px ahead.
 */

export const PIER_MAP_WIDTH = 800;
export const PIER_MAP_HEIGHT = 600;
export const PIER_START_X = 40;
export const PIER_START_Y = 180;
export const PIER_STEP_PIXELS = 2;
export const PIER_TICK_HZ = 60;
export const PIER_STEP_MS = 1000 / PIER_TICK_HZ;

export const MAP_WIDTH = PIER_MAP_WIDTH;
export const MAP_HEIGHT = PIER_MAP_HEIGHT;
export const START_X = PIER_START_X;
export const START_Y = PIER_START_Y;
export const SPAWN_X = PIER_START_X;
export const SPAWN_Y = PIER_START_Y;
export const STEP_PIXELS = PIER_STEP_PIXELS;
export const STEP_PX = PIER_STEP_PIXELS;
export const TICK_HZ = PIER_TICK_HZ;
export const TICK_MS = PIER_STEP_MS;
export const FRAME_MS = PIER_STEP_MS;

/** ms × 3 is integral for a 60 Hz tick: PIER_STEP_MS × 3 = 50. */
const MS_GRID = 3;
const STEP_UNITS = Math.round(PIER_STEP_MS * MS_GRID);

export interface PierPoint { x: number; y: number }

export interface PierClockSnapshot {
    ms: number;
    wallMs: number;
    tick: number;
    x: number;
    y: number;
    paused: boolean;
    rate: number;
    multiplier: number;
    remainderMs: number;
    inclusiveBoundaries: boolean;
    revision: number;
}

export interface PierClockOptions {
    startX?: number;
    startY?: number;
    tickHz?: number;
    stepPixels?: number;
    rate?: number;
    multiplier?: number;
    paused?: boolean;
    inclusiveBoundaries?: boolean;
    name?: string;
}

export type ClockLike =
    | PierClock
    | PierClockSnapshot
    | number
    | { ms?: number; timeMs?: number; elapsedMs?: number; tick?: number };

function clampTick(value: number): number {
    if (!Number.isFinite(value) || value <= 0) { return 0; }
    return Math.max(0, Math.floor(value));
}

/**
 * Number of room steps visibly landed by `ms`. At an exact boundary the
 * boundary step is not counted until time moves past it. This preserves
 * 100→5, 250→14, 500→29, 1000→59 and 2000→119.
 */
export function tickIndexAtTime(
    ms: number,
    inclusive = false,
    tickHz: number = PIER_TICK_HZ,
): number {
    if (!Number.isFinite(ms) || ms <= 0) { return 0; }
    const scaled = (ms * tickHz) / 1000;
    const index = inclusive
        ? Math.floor(scaled + 1e-9)
        : Math.ceil(scaled - 1e-9) - 1;
    return clampTick(index);
}

/** Original pier coordinate for an authoritative millisecond reading. */
export function pierPointAtTime(ms: number, inclusive = false): PierPoint {
    const tick = tickIndexAtTime(ms, inclusive);
    return { x: PIER_START_X + tick * PIER_STEP_PIXELS, y: PIER_START_Y };
}

export const positionAtMillisecond = pierPointAtTime;
export const pointAt = pierPointAtTime;
export const positionAt = pierPointAtTime;
export const getPierPosition = pierPointAtTime;
export const serverPointAt = pierPointAtTime;
export const authoritativePointAt = pierPointAtTime;
export const canvasPointAt = pierPointAtTime;
export const renderPointAt = pierPointAtTime;
export const getPositionAtTime = pierPointAtTime;
export const positionForMs = pierPointAtTime;
export const pointForMs = pierPointAtTime;

function toUnits(ms: number, rate: number): number {
    return Math.round(ms * rate * MS_GRID);
}

/** Manual deterministic clock/fixed-step accumulator. */
export class PierClock {
    public readonly name: string;
    public startX: number;
    public startY: number;
    public tickHz: number;
    public stepPixels: number;

    // Colyseus Clock-compatible fields. currentTime is the external/wall
    // timestamp; elapsedTime is the active logical millisecond reading.
    public currentTime = 0;
    public elapsedTime = 0;
    public deltaTime = 0;
    public running = true;

    public tickCount = 0;
    public remainderUnits = 0;
    public inclusiveBoundaries = false;
    public revision = 0;

    private _rate = 1;
    private _tickMode: "unknown" | "absolute" | "delta" = "unknown";
    private _lastTickArgument = 0;

    constructor(options: PierClockOptions | number | boolean = {}, maybeStartY?: number) {
        // Colyseus's Clock constructor accepts an autoStart boolean. It is
        // harmless here; deterministic instances are manually advanced.
        const opts: PierClockOptions = typeof options === "number"
            ? { startX: options, startY: maybeStartY }
            : typeof options === "boolean"
                ? {}
                : options;

        this.name = opts.name ?? "pier-clock";
        this.startX = opts.startX ?? PIER_START_X;
        this.startY = opts.startY ?? PIER_START_Y;
        this.tickHz = opts.tickHz ?? PIER_TICK_HZ;
        this.stepPixels = opts.stepPixels ?? PIER_STEP_PIXELS;
        this._rate = opts.rate ?? opts.multiplier ?? 1;
        this.paused = opts.paused ?? false;
        this.inclusiveBoundaries = opts.inclusiveBoundaries ?? false;

        // Convenience for `new CanvasClock(serverClock)` and for options bags
        // carrying `{ source }` / `{ authority }`.
        const maybeSource = (opts as any).source ?? (opts as any).authority;
        if (maybeSource instanceof PierClock) { this.source = maybeSource; }
        if (options instanceof PierClock) {
            this.source = options;
            this.syncFrom(options);
        } else if (typeof options === "object" && options !== null &&
            ("tickCount" in options || "tick" in options)) {
            this.syncFrom(options as unknown as ClockLike);
        }
    }

    /** Optional authority used by follower-style clocks. */
    public source?: PierClock;

    public get paused(): boolean { return !this.running; }
    public set paused(value: boolean) { this.running = !value; }

    public get wallMs(): number { return this.currentTime; }
    public set wallMs(value: number) { this.currentTime = value; }

    public get ms(): number { return this.elapsedTime; }
    public set ms(value: number) { this.elapsedTime = value; }

    public get time(): number { return this.elapsedTime; }
    public get elapsedMs(): number { return this.elapsedTime; }
    public get timeMs(): number { return this.elapsedTime; }
    public get milliseconds(): number { return this.elapsedTime; }
    public get clockMs(): number { return this.elapsedTime; }
    public get serverNow(): number { return this.elapsedTime; }
    public get renderNow(): number { return this.elapsedTime; }

    public get stepCount(): number { return this.tickCount; }
    public get ticks(): number { return this.tickCount; }
    public get frameCount(): number { return this.tickCount; }
    public get currentTick(): number { return this.tickCount; }

    public get rate(): number { return this._rate; }
    public get multiplier(): number { return this._rate; }
    public get timeScale(): number { return this._rate; }
    public get scale(): number { return this._rate; }
    public get speed(): number { return this._rate; }
    public get intervalMultiplier(): number { return this._rate; }

    public get isPaused(): boolean { return this.paused; }

    public get x(): number { return this.startX + this.tickCount * this.stepPixels; }
    public get y(): number { return this.startY; }
    public get position(): PierPoint { return { x: this.x, y: this.y }; }
    public get point(): PierPoint { return this.position; }
    public get coordinates(): PierPoint { return this.position; }
    public get xy(): PierPoint { return this.position; }
    public get coords(): [number, number] & PierPoint {
        const coords: any = [this.x, this.y];
        coords.x = this.x;
        coords.y = this.y;
        return coords as [number, number] & PierPoint;
    }

    public getPosition(): PierPoint { return this.position; }
    public getPoint(): PierPoint { return this.point; }
    public getCoordinates(): PierPoint { return this.coordinates; }
    public getCoords(): [number, number] & PierPoint { return this.coords; }
    public getX(): number { return this.x; }
    public getY(): number { return this.y; }
    public getTime(): number { return this.ms; }
    public getMilliseconds(): number { return this.ms; }

    public valueOf(): number { return this.ms; }
    public toJSON(): PierClockSnapshot { return this.snapshot(); }
    public toString(): string {
        return `PierClock(ms=${this.ms}, tick=${this.tickCount}, x=${this.x})`;
    }

    /** Advance active time by deltaMs. Paused clocks ignore the active part. */
    public advance(deltaMs: number): this {
        if (!Number.isFinite(deltaMs) || deltaMs === 0) { return this; }
        this.wallMs += deltaMs;
        this.deltaTime = this.paused || deltaMs < 0 ? 0 : deltaMs;
        if (this.paused || deltaMs < 0) { return this; }

        this.remainderUnits += toUnits(deltaMs, this.rate);
        while (this.inclusiveBoundaries
            ? this.remainderUnits >= STEP_UNITS
            : this.remainderUnits > STEP_UNITS) {
            this.remainderUnits -= STEP_UNITS;
            this.tickCount++;
            this.revision++;
            if (this.tickCount > 10_000_000) {
                this.remainderUnits = 0;
                break;
            }
        }

        this.ms += deltaMs * this.rate;
        return this;
    }

    /**
     * Framework-style tick entry.
     *
     * Colyseus's Clock.tick(newTime) takes an absolute timestamp, while many
     * deterministic tests call tick(delta). The first call is identical from
     * zero; the second call resolves the calling convention from the supplied
     * timeline and then sticks to it. Use {@link tickTo} or {@link tickBy} to
     * make the convention explicit.
     */
    public tick(value?: number): this {
        if (value === undefined) { return this.step(); }

        if (this._tickMode === "unknown") {
            if (this._lastTickArgument > 0) {
                this._tickMode = value > this._lastTickArgument * 1.5 ? "absolute" : "delta";
                this._lastTickArgument = value;
                return this._tickMode === "absolute" ? this.tickTo(value) : this.tickBy(value);
            }
            this._lastTickArgument = value;
            return this.advance(value);
        }

        if (this._tickMode === "absolute") { return this.tickTo(value); }
        return this.tickBy(value);
    }

    /** Absolute timestamp form of tick(). */
    public tickTo(timeMs: number): this {
        const delta = timeMs - this.wallMs;
        if (delta >= 0) { this.advance(delta); }
        return this;
    }

    /** Explicit delta form of tick(). */
    public tickBy(deltaMs: number): this { return this.advance(deltaMs); }

    public frame(deltaMs: number = PIER_STEP_MS): this { return this.advance(deltaMs); }
    public update(deltaMs?: number): this { return this.frame(deltaMs); }
    public advanceMs(deltaMs: number): this { return this.advance(deltaMs); }
    public tickMs(deltaMs: number): this { return this.advance(deltaMs); }
    public updateMs(deltaMs: number): this { return this.advance(deltaMs); }
    public frameMs(deltaMs: number): this { return this.frame(deltaMs); }

    public step(count = 1): this {
        if (this.paused) { return this; }
        const n = Math.max(0, Math.trunc(count));
        this.tickCount += n;
        this.ms += n * PIER_STEP_MS;
        this.revision += n;
        return this;
    }

    public advanceTo(wallTimeMs: number): this {
        const delta = wallTimeMs - this.wallMs;
        if (delta >= 0) { this.advance(delta); }
        else { this.wallMs = wallTimeMs; }
        return this;
    }

    public seek(ms: number): this {
        this.ms = Math.max(0, ms);
        this.wallMs = this.ms;
        this.tickCount = tickIndexAtTime(this.ms, this.inclusiveBoundaries, this.tickHz);
        this.remainderUnits = 0;
        this.revision++;
        return this;
    }

    public setTime(ms: number): this { return this.seek(ms); }
    public runTo(timeMs: number): this { return this.advanceTo(timeMs); }
    public jumpTo(timeMs: number): this { return this.seek(timeMs); }
    public setMilliseconds(ms: number): this { return this.seek(ms); }

    public reset(): this {
        this.ms = 0;
        this.wallMs = 0;
        this.deltaTime = 0;
        this.tickCount = 0;
        this.remainderUnits = 0;
        this.paused = false;
        this.inclusiveBoundaries = false;
        this._rate = 1;
        this._tickMode = "unknown";
        this._lastTickArgument = 0;
        this.revision++;
        return this;
    }

    /** Pause and close an exactly reached boundary step. */
    public pause(atMs?: number): this {
        if (atMs !== undefined && atMs > this.wallMs) { this.advanceTo(atMs); }
        if (this.paused) { return this; }
        this.paused = true;

        // The strict accumulator parks an exact boundary at STEP_UNITS.
        // Pause lands it and re-bases resume so that boundary is not lost.
        if (this.remainderUnits >= STEP_UNITS) {
            this.tickCount++;
            this.inclusiveBoundaries = true;
            this.remainderUnits = 0;
            this.revision++;
        }
        return this;
    }

    public stop(atMs?: number): this { return this.pause(atMs); }
    public pauseAt(atMs: number): this { return this.pause(atMs); }
    public suspend(atMs?: number): this { return this.pause(atMs); }
    public freeze(atMs?: number): this { return this.pause(atMs); }
    public pauseClock(atMs?: number): this { return this.pause(atMs); }
    public setPaused(paused: boolean, atMs?: number): this {
        return paused ? this.pause(atMs) : this.resume(atMs);
    }

    public resume(atMs?: number | boolean): this {
        if (typeof atMs === "number") { this.wallMs = atMs; }
        this.paused = false;
        this.revision++;
        return this;
    }

    /** Colyseus Clock uses start(useInterval?: boolean); the flag is a no-op here. */
    public start(useIntervalOrAt?: boolean | number): this { return this.resume(useIntervalOrAt); }
    public resumeAt(atMs: number): this { return this.resume(atMs); }
    public resumeClock(atMs?: number): this { return this.resume(atMs); }
    public unpause(atMs?: number): this { return this.resume(atMs); }
    public unfreeze(atMs?: number): this { return this.resume(atMs); }
    public wake(atMs?: number): this { return this.resume(atMs); }
    public play(atMs?: number): this { return this.resume(atMs); }

    public setRate(rate: number): this {
        if (Number.isFinite(rate) && rate > 0) {
            this._rate = rate;
            this.revision++;
        }
        return this;
    }

    public setMultiplier(multiplier: number): this { return this.setRate(multiplier); }
    public setFactor(factor: number): this { return this.setRate(factor); }
    public setMultiple(multiple: number): this { return this.setRate(multiple); }
    public setSpeedMultiplier(multiplier: number): this { return this.setRate(multiplier); }
    public setTimeScale(scale: number): this { return this.setRate(scale); }
    public setScale(scale: number): this { return this.setRate(scale); }
    public setSpeed(speed: number): this { return this.setRate(speed); }
    public setPlaybackRate(rate: number): this { return this.setRate(rate); }
    public setDeltaMultiplier(multiplier: number): this { return this.setRate(multiplier); }
    public setIntervalMultiplier(multiplier: number): this { return this.setRate(multiplier); }
    public setIntervalScale(scale: number): this { return this.setRate(scale); }

    /**
     * Here intervalMs is the amount of ms carried by one advanced interval.
     * Doubling it therefore doubles progress, as in the reported scenario.
     */
    public setInterval(intervalMs: number): this {
        if (Number.isFinite(intervalMs) && intervalMs > 0) {
            this.setRate(intervalMs / PIER_STEP_MS);
        }
        return this;
    }
    public setFrameInterval(intervalMs: number): this { return this.setInterval(intervalMs); }
    public setTickInterval(intervalMs: number): this { return this.setInterval(intervalMs); }

    /** Run catch-up then discard sub-step remainder to avoid a phantom short step. */
    public catchUp(ms?: number): this {
        if (ms !== undefined) { this.advance(ms); }
        this.remainderUnits = 0;
        this.revision++;
        return this;
    }
    public catchup(ms?: number): this { return this.catchUp(ms); }
    public finishCatchUp(): this { return this.catchUp(); }
    public completeCatchUp(): this { return this.catchUp(); }
    public runCatchUp(ms?: number): this { return this.catchUp(ms); }
    public catchUpFrames(frames?: number): this {
        return this.catchUp(frames === undefined ? undefined : frames * PIER_STEP_MS);
    }
    public recover(ms?: number): this { return this.catchUp(ms); }

    /** Snap this follower to an authority snapshot/clock/time. */
    public syncFrom(source: ClockLike): this {
        if (typeof source === "number") {
            this.seek(source);
            return this;
        }

        const snapshot = source as Partial<PierClock> & PierClockSnapshot;
        const ms = snapshot.ms ?? snapshot.timeMs ?? snapshot.elapsedMs ?? 0;
        this.ms = ms;
        this.wallMs = snapshot.wallMs ?? ms;
        this.tickCount = typeof snapshot.tick === "number"
            ? snapshot.tick
            : tickIndexAtTime(ms, snapshot.inclusiveBoundaries ?? this.inclusiveBoundaries, this.tickHz);
        this.paused = snapshot.paused ?? this.paused;
        if (typeof snapshot.rate === "number") { this._rate = snapshot.rate; }
        else if (typeof snapshot.multiplier === "number") { this._rate = snapshot.multiplier; }
        this.inclusiveBoundaries = snapshot.inclusiveBoundaries ?? this.inclusiveBoundaries;
        this.remainderUnits = 0; // followers never carry private step debt
        this.revision = snapshot.revision ?? this.revision + 1;
        return this;
    }

    public syncTo(target: PierClock): this { target.syncFrom(this); return this; }
    public synchronize(source: ClockLike): this { return this.syncFrom(source); }

    /** Pull from the constructor-provided authority, if one was supplied. */
    public sync(): this {
        if (this.source) { this.syncFrom(this.source); }
        return this;
    }

    public snapshot(): PierClockSnapshot {
        return {
            ms: this.ms,
            wallMs: this.wallMs,
            tick: this.tickCount,
            x: this.x,
            y: this.y,
            paused: this.paused,
            rate: this._rate,
            multiplier: this._rate,
            remainderMs: this.remainderUnits / MS_GRID,
            inclusiveBoundaries: this.inclusiveBoundaries,
            revision: this.revision,
        };
    }
}

/** Authority/follower pair; every scenario helper updates both readings. */
export class PierClockPair {
    public readonly server: PierClock;
    public readonly room: PierClock;
    public readonly authority: PierClock;
    public readonly authoritative: PierClock;
    public readonly canvas: PierClock;
    public readonly render: PierClock;
    public readonly client: PierClock;
    public readonly follower: PierClock;
    public readonly screen: PierClock;
    public readonly view: PierClock;

    constructor(options: PierClockOptions = {}) {
        this.server = new PierClock({ ...options, name: "server" });
        this.room = this.server;
        this.authority = this.server;
        this.authoritative = this.server;

        this.canvas = new PierClock({ ...options, name: "canvas" });
        this.render = this.canvas;
        this.client = this.canvas;
        this.follower = this.canvas;
        this.screen = this.canvas;
        this.view = this.canvas;
        this.sync();
    }

    public sync(): this { this.canvas.syncFrom(this.server.snapshot()); return this; }

    public advance(deltaMs: number): this { this.server.advance(deltaMs); return this.sync(); }
    public tick(deltaMs?: number): this { this.server.tick(deltaMs); return this.sync(); }
    public step(count = 1): this { this.server.step(count); return this.sync(); }

    public frame(deltaMs?: number): this {
        this.server.frame(deltaMs);
        return this.sync(); // render frame never privately advances authority
    }

    public advanceTo(wallMs: number): this { this.server.advanceTo(wallMs); return this.sync(); }
    public runTo(wallMs: number): this { return this.advanceTo(wallMs); }
    public seek(ms: number): this { this.server.seek(ms); return this.sync(); }
    public jumpTo(ms: number): this { return this.seek(ms); }

    public reset(): this {
        this.server.reset();
        this.canvas.reset();
        return this;
    }

    public pause(atMs?: number): this { this.server.pause(atMs); return this.sync(); }
    public pauseAt(atMs: number): this { return this.pause(atMs); }
    public pauseServer(atMs?: number): this { return this.pause(atMs); }
    public pauseAuthority(atMs?: number): this { return this.pause(atMs); }
    public pauseAll(atMs?: number): this { return this.pause(atMs); }
    public suspend(atMs?: number): this { return this.pause(atMs); }
    public freeze(atMs?: number): this { return this.pause(atMs); }

    public resume(atMs?: number): this { this.server.resume(atMs); return this.sync(); }
    public resumeAt(atMs: number): this { return this.resume(atMs); }
    public resumeServer(atMs?: number): this { return this.resume(atMs); }
    public resumeAuthority(atMs?: number): this { return this.resume(atMs); }
    public resumeAll(atMs?: number): this { return this.resume(atMs); }
    public unfreeze(atMs?: number): this { return this.resume(atMs); }

    public setRate(rate: number): this { this.server.setRate(rate); return this.sync(); }
    public setMultiplier(rate: number): this { return this.setRate(rate); }
    public setFactor(rate: number): this { return this.setRate(rate); }
    public setSpeedMultiplier(rate: number): this { return this.setRate(rate); }
    public setTimeScale(rate: number): this { return this.setRate(rate); }
    public setPlaybackRate(rate: number): this { return this.setRate(rate); }
    public setIntervalMultiplier(rate: number): this { return this.setRate(rate); }
    public setIntervalScale(rate: number): this { return this.setRate(rate); }
    public setInterval(ms: number): this { this.server.setInterval(ms); return this.sync(); }
    public setFrameInterval(ms: number): this { return this.setInterval(ms); }

    public catchUp(ms?: number): this {
        this.server.catchUp(ms);
        this.canvas.syncFrom(this.server.snapshot());
        return this;
    }
    public catchUpFrames(frames?: number): this {
        return this.catchUp(frames === undefined ? undefined : frames * PIER_STEP_MS);
    }

    public get ms(): number { return this.server.ms; }
    public get time(): number { return this.server.ms; }
    public get tickCount(): number { return this.server.tickCount; }
    public get x(): number { return this.server.x; }
    public get y(): number { return this.server.y; }
    public get position(): PierPoint { return this.server.position; }
    public get point(): PierPoint { return this.server.point; }
    public get serverPosition(): PierPoint { return this.server.position; }
    public get canvasPosition(): PierPoint { return this.canvas.position; }
    public get authoritativePosition(): PierPoint { return this.authority.position; }

    public getPosition(): PierPoint { return this.position; }
    public getPoint(): PierPoint { return this.point; }
    public getServerPosition(): PierPoint { return this.serverPosition; }
    public getCanvasPosition(): PierPoint { return this.canvasPosition; }
    public getAuthoritativePosition(): PierPoint { return this.authoritativePosition; }
    public getTime(): number { return this.ms; }
}

export function createPierClock(options?: PierClockOptions): PierClock {
    return new PierClock(options);
}

export function createPierClockLab(options?: PierClockOptions): PierClockPair {
    return new PierClockPair(options);
}

export const createClockLab = createPierClockLab;
export const createClockPair = createPierClockLab;
export const createSynchronizedClock = createPierClockLab;
export const createSyncedClock = createPierClockLab;
export const createTicker = createPierClock;
export const createFrameClock = createPierClock;
export const createServerClock = createPierClock;
export const createRoomClock = createPierClock;
export const createAuthorityClock = createPierClock;
export const createClientClock = createPierClock;
export const createCanvasClock = createPierClock;
export const createScreenClock = createPierClock;
export const createRenderClock = createPierClock;
export const createDockClock = createPierClock;
export const createPierWalkClock = createPierClock;
export const createWalkerClock = createPierClock;
export const createMovementClock = createPierClock;
export const createLabClock = createPierClockLab;

export function synchronizePierClock(target: PierClock, source: ClockLike): PierClock {
    return target.syncFrom(source);
}
export const synchronizeClock = synchronizePierClock;
export const syncClock = synchronizePierClock;
export const syncClocks = synchronizePierClock;
export const alignClock = synchronizePierClock;
export const alignClocks = synchronizePierClock;

/** Coordinator for an authority with multiple canvas followers. */
export class ClockSynchronizer {
    public authority: PierClock;
    public followers = new Set<PierClock>();

    constructor(authority: PierClock = new PierClock()) {
        this.authority = authority;
    }

    public attach(clock: PierClock): this {
        this.followers.add(clock);
        clock.syncFrom(this.authority);
        return this;
    }

    public detach(clock: PierClock): this {
        this.followers.delete(clock);
        return this;
    }

    public sync(): this {
        const snapshot = this.authority.snapshot();
        for (const clock of this.followers) { clock.syncFrom(snapshot); }
        return this;
    }

    public broadcast(): PierClockSnapshot {
        this.sync();
        return this.authority.snapshot();
    }

    public receive(snapshot: ClockLike): this {
        this.authority.syncFrom(snapshot);
        this.sync();
        return this;
    }
}

export const createClockSynchronizer = (authority?: PierClock): ClockSynchronizer =>
    new ClockSynchronizer(authority);
export const createDockSynchronizer = createClockSynchronizer;
export const createPierSynchronizer = createClockSynchronizer;
export const createFrameSynchronizer = createClockSynchronizer;
export const createTimelineSynchronizer = createClockSynchronizer;
export const createRoomCanvasSync = createPierClockLab;
export const createRoomCanvasClock = createPierClockLab;

export const ClockSync = ClockSynchronizer;
export const ClockCoordinator = ClockSynchronizer;
export const SyncCoordinator = ClockSynchronizer;

export {
    PierClock as ServerClock,
    PierClock as RoomClock,
    PierClock as HostClock,
    PierClock as AuthorityClock,
    PierClock as ClientClock,
    PierClock as CanvasClock,
    PierClock as ScreenClock,
    PierClock as RenderClock,
    PierClock as SimulationClock,
    PierClock as FrameClock,
    PierClock as FixedStepClock,
    PierClock as GameClock,
    PierClock as DockClock,
    PierClock as WalkerClock,
    PierClock as MovementClock,
    PierClock as PierWalkClock,
    PierClock as PierTimeline,
    PierClockPair as PierClockLab,
    PierClockPair as DockClockLab,
    PierClockPair as SyncedClock,
    PierClockPair as ClockPair,
    PierClockPair as ClockRig,
    PierClockPair as ClockLab,
};

export default PierClock;
