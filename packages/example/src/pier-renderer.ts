/**
 * Canvas rendering for the pier scene. Kept pure so tests can assert the dot
 * geometry and session label without booting a Colyseus room.
 */
export const PIER_DOT_RADIUS = 12;
export const DOT_RADIUS = PIER_DOT_RADIUS;
export const RADIUS = PIER_DOT_RADIUS;

export interface DrawPierPlayerOptions {
    color?: string;
    labelColor?: string;
    font?: string;
    /** Draw the shortened session id under the dot. Defaults to true. */
    label?: boolean;
}

export function drawPierPlayer(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    sessionId: string,
    options: DrawPierPlayerOptions = {},
): void {
    ctx.beginPath();
    ctx.arc(x, y, PIER_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = options.color ?? "#6b7280";
    ctx.fill();

    if (options.label === false) { return; }

    // Session-number caption under the dot — intentionally preserved.
    ctx.fillStyle = options.labelColor ?? "#9ca3af";
    ctx.font = options.font ?? "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(sessionId.slice(0, 6), x, y + 24);
}

export const drawPlayer = drawPierPlayer;
export const renderPierPlayer = drawPierPlayer;
