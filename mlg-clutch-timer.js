/**
 * MLG Clutch Timer — LiquidBounce (NextGen, GraalJS script API)
 *
 * While you are falling, this module slows the client-side game timer down.
 * The closer you get to the surface below you, the slower time runs, so you get
 * more real time to place a water bucket or a block. A centered HUD shows the
 * predicted impact time, height, vertical speed, active time scale and the
 * estimated fall damage, and it warns you when it is time to place.
 *
 * Install: drop this file into LiquidBounce's `scripts` folder, then enable
 * "MLG Clutch Timer" from the Movement category. Only client timing is
 * affected — the server still runs at its own speed.
 */

const script = registerScript({
    name: "MLG Clutch Timer",
    version: "1.1.0",
    authors: ["Buffy"]
});

/* Vanilla player physics, in blocks per tick. */
const GRAVITY = 0.08;
const DRAG = 0.98;
const MAX_PREDICTION_TICKS = 240;
const MAX_SCAN_DISTANCE = 128;

/* Horizontal offsets used to sample the player's 0.6 x 0.6 hitbox corners. */
const EDGE_OFFSET = 0.29;

const DirectionAxis = Java.type("net.minecraft.core.Direction$Axis");

/* Timer API used to scale client time. The HUD keeps working without it. */
let clientTimer = null;
let timerPriority = null;
try {
    clientTimer = Java.type("net.ccbluex.liquidbounce.utils.client.Timer").INSTANCE;
    timerPriority = Java.type("net.ccbluex.liquidbounce.utils.kotlin.Priority").NORMAL;
} catch (error) {
    try {
        Client.displayChatMessage("§c[MLG Clutch Timer] §7Client timer API unavailable — HUD only.");
    } catch (ignored) {
        /* Chat is best-effort too. */
    }
}

/**
 * Calls a Minecraft method that may not exist under every mapping set and
 * falls back to a sane default instead of breaking the whole module.
 */
function safeCall(callback, fallback) {
    try {
        const value = callback();
        return value === undefined || value === null ? fallback : value;
    } catch (error) {
        return fallback;
    }
}

function say(message) {
    try {
        Client.displayChatMessage("§b[MLG] §7" + message);
    } catch (error) {
        /* Ignore chat failures. */
    }
}

function argb(alpha, red, green, blue) {
    return ((alpha << 24) | (red << 16) | (green << 8) | blue) | 0;
}

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

/**
 * Highest collidable surface in one block column at or below the given height,
 * or null when nothing is found down to `bottomY`.
 */
function surfaceAtColumn(level, x, z, startY, feetY, bottomY) {
    for (let y = startY; y >= bottomY; y--) {
        const pos = new BlockPos(x, y, z);
        const state = level.getBlockState(pos);
        if (state.isAir()) {
            continue;
        }

        const shape = state.getCollisionShape(level, pos);
        if (shape.isEmpty()) {
            continue;
        }

        const surfaceY = y + shape.max(DirectionAxis.Y);
        if (surfaceY <= feetY + 1.0e-4) {
            return surfaceY;
        }
    }

    return null;
}

/**
 * Highest surface under the player's hitbox. The center column is scanned
 * fully; the three remaining corner columns only need to look for something
 * higher than the center result, which keeps the per-tick cost tiny even over
 * a void. Taking the highest hit is correct: that is the first thing you land
 * on when you are standing over a block edge.
 */
function findGroundY(player) {
    const level = player.level();
    const feetY = player.getY();
    const startY = Math.floor(feetY);
    const centerX = Math.floor(player.getX());
    const centerZ = Math.floor(player.getZ());

    let best = surfaceAtColumn(level, centerX, centerZ, startY, feetY, startY - MAX_SCAN_DISTANCE);

    const centerBottom = best === null ? startY - MAX_SCAN_DISTANCE : Math.floor(best);
    for (const offsetX of [-EDGE_OFFSET, EDGE_OFFSET]) {
        for (const offsetZ of [-EDGE_OFFSET, EDGE_OFFSET]) {
            const x = Math.floor(player.getX() + offsetX);
            const z = Math.floor(player.getZ() + offsetZ);
            if (x === centerX && z === centerZ) {
                continue;
            }

            const surface = surfaceAtColumn(level, x, z, startY, feetY, centerBottom);
            if (surface !== null && (best === null || surface > best)) {
                best = surface;
            }
        }
    }

    return best;
}

/**
 * Simulates vanilla player gravity until the feet have fallen `distance`
 * blocks, returning the ticks left and the impact speed in blocks per tick.
 * Returns null when the ground is not reached within MAX_PREDICTION_TICKS.
 */
function predictImpact(motionY, distance) {
    let velocity = motionY;
    let fallen = 0;

    for (let ticks = 1; ticks <= MAX_PREDICTION_TICKS; ticks++) {
        velocity = (velocity - GRAVITY) * DRAG;
        fallen -= velocity;

        if (fallen >= distance) {
            return { ticks: ticks, impactSpeed: -velocity };
        }
    }

    return null;
}

/* 1x at the top of the effect, MinSpeed right above the ground (smoothstep). */
function speedForDistance(distance, effectHeight, minSpeed) {
    const progress = clamp01(1 - distance / effectHeight);
    const eased = progress * progress * (3 - 2 * progress);
    return 1 - (1 - minSpeed) * eased;
}

/* Vanilla fall damage in half hearts, ignoring Feather Falling. */
function estimateFallDamage(fallDistance) {
    return fallDistance <= 3 ? 0 : Math.ceil(fallDistance - 3);
}

script.registerModule({
    name: "MLG Clutch Timer",
    category: "Movement",
    description: "Slows down time as you fall to help hit MLG clutches",
    settings: {
        effectHeight: Setting.float({
            name: "EffectHeight",
            default: 8.0,
            range: [2.0, 48.0],
            suffix: "blocks"
        }),
        autoEffectHeight: Setting.boolean({
            name: "AutoEffectHeight",
            default: true
        }),
        minSpeed: Setting.float({
            name: "MinSpeed",
            default: 0.35,
            range: [0.1, 1.0],
            suffix: "x"
        }),
        minFallDistance: Setting.float({
            name: "MinFallDistance",
            default: 3.0,
            range: [0.0, 16.0],
            suffix: "blocks"
        }),
        criticalTicks: Setting.int({
            name: "CriticalTicks",
            default: 8,
            range: [0, 40]
        }),
        showHud: Setting.boolean({
            name: "ShowHud",
            default: true
        }),
        showDetails: Setting.boolean({
            name: "ShowDetails",
            default: true
        }),
        chatFeedback: Setting.boolean({
            name: "ChatFeedback",
            default: false
        })
    }
}, (mod) => {
    let engaged = false;
    let ticksLeft = 0;
    let distanceToGround = 0;
    let timeScale = 1;
    let activeEffectHeight = 8;
    let fallDistance = 0;
    let impactSpeed = 0;
    let predictedDamage = 0;
    let fallApexY = null;

    function requestTimerSpeed(speed) {
        if (clientTimer === null) {
            return;
        }

        try {
            clientTimer.requestTimerSpeed(Math.fround(speed), timerPriority, mod, 1);
        } catch (error) {
            clientTimer = null;
        }
    }

    function restoreTime() {
        // Only send a reset when this module actually changed the timer, so a
        // running Timer module is not fought every tick.
        if (engaged || timeScale !== 1) {
            requestTimerSpeed(1.0);
        }

        engaged = false;
        ticksLeft = 0;
        distanceToGround = 0;
        timeScale = 1;
        fallDistance = 0;
        impactSpeed = 0;
        predictedDamage = 0;
    }

    /* Long falls get a taller ramp so the slowdown starts early enough to matter. */
    function effectiveHeight(gap, totalFall) {
        const configured = mod.settings.effectHeight.value;
        if (!mod.settings.autoEffectHeight.value) {
            return configured;
        }

        const scaled = Math.max(gap, totalFall) * 0.75;
        return Math.max(configured, Math.min(48, scaled));
    }

    function reportLanding() {
        if (!mod.settings.chatFeedback.value || !engaged) {
            return;
        }

        const damage = predictedDamage > 0 ? `~${predictedDamage} HP` : "no damage";
        say(`Landed after ${fallDistance.toFixed(1)} blocks — impact ${impactSpeed.toFixed(2)} b/t, ${damage}`);
    }

    mod.on("enable", () => {
        engaged = false;
        ticksLeft = 0;
        distanceToGround = 0;
        timeScale = 1;
        fallApexY = null;
    });

    mod.on("disable", () => {
        fallApexY = null;
        restoreTime();
    });

    mod.on("worldChange", () => {
        fallApexY = null;
        restoreTime();
    });

    mod.on("playerTick", () => {
        try {
            tick();
        } catch (error) {
            // Never leave client time slowed because of a mapping/API problem.
            fallApexY = null;
            restoreTime();
        }
    });

    function tick() {
        const player = mc.player;
        if (player === null || player.level() === null) {
            fallApexY = null;
            restoreTime();
            return;
        }

        const grounded = safeCall(() => player.onGround(), true);
        const inWater = safeCall(() => player.isInWater(), false);
        const inLava = safeCall(() => player.isInLava(), false);
        const inVehicle = safeCall(() => player.isPassenger(), false);
        const flying = safeCall(() => player.isFallFlying(), false);
        const invalid = safeCall(() => !player.isAlive(), true)
            || safeCall(() => player.isSpectator(), false);

        if (grounded || inWater || inLava || inVehicle || flying || invalid) {
            reportLanding();
            fallApexY = null;
            restoreTime();
            return;
        }

        const y = player.getY();
        if (fallApexY === null || y > fallApexY) {
            fallApexY = y;
        }

        const motionY = player.getDeltaMovement().y;
        if (motionY >= 0) {
            // Rising or floating: keep tracking the apex, but give the time back.
            restoreTime();
            return;
        }

        const groundY = findGroundY(player);
        if (groundY === null) {
            restoreTime();
            return;
        }

        const gap = y - groundY;
        const totalFall = Math.max(gap, fallApexY - groundY);

        // MinFallDistance describes how far you have already fallen, not how
        // much height is left. Gating on the remaining gap would hand the time
        // back in the last few blocks, exactly when the clutch is needed.
        if (!engaged && totalFall < mod.settings.minFallDistance.value) {
            restoreTime();
            return;
        }

        const prediction = predictImpact(motionY, gap);
        if (prediction === null) {
            restoreTime();
            return;
        }

        const effectHeight = effectiveHeight(gap, totalFall);
        const speed = speedForDistance(gap, effectHeight, mod.settings.minSpeed.value);
        const previousScale = timeScale;

        engaged = true;
        ticksLeft = prediction.ticks;
        distanceToGround = gap;
        timeScale = speed;
        activeEffectHeight = effectHeight;
        fallDistance = totalFall;
        impactSpeed = prediction.impactSpeed;
        predictedDamage = estimateFallDamage(totalFall);

        // Re-requested every tick: the request only lasts one game tick.
        if (speed < 0.999) {
            requestTimerSpeed(speed);
        } else if (previousScale < 0.999) {
            requestTimerSpeed(1.0);
        }
    }

    mod.on("overlayRender", (event) => {
        if (!engaged || ticksLeft <= 0 || !mod.settings.showHud.value) {
            return;
        }

        const context = event.context;
        const font = mc.font;
        const ratio = clamp01(1 - distanceToGround / activeEffectHeight);
        const criticalTicks = Math.round(mod.settings.criticalTicks.value);
        const critical = criticalTicks > 0 && ticksLeft <= criticalTicks;
        const flash = critical && Math.floor(Date.now() / 140) % 2 === 0;

        const mainText = `Impact in ${(ticksLeft / 20).toFixed(2)}s (${ticksLeft}t)`;

        let mainColor;
        if (critical) {
            mainColor = flash ? argb(0xff, 255, 70, 70) : argb(0xff, 255, 190, 70);
        } else {
            mainColor = argb(0xff, 255, Math.round(255 - 170 * ratio), Math.round(90 - 40 * ratio));
        }

        const lines = [{ text: mainText, color: mainColor, width: font.width(mainText) }];

        if (mod.settings.showDetails.value) {
            const details = `${distanceToGround.toFixed(1)} b  |  -${impactSpeed.toFixed(2)} b/t  |  x${timeScale.toFixed(2)}`;
            lines.push({ text: details, color: argb(0xff, 190, 190, 190), width: font.width(details) });

            const damage = predictedDamage > 0 ? `~${predictedDamage} HP` : "no damage";
            const fallText = `Fall ${fallDistance.toFixed(1)} b  |  ${damage}`;
            lines.push({ text: fallText, color: argb(0xff, 160, 160, 160), width: font.width(fallText) });
        }

        if (critical) {
            const warning = "PLACE NOW";
            lines.push({ text: warning, color: flash ? argb(0xff, 255, 90, 90) : argb(0xff, 255, 210, 120), width: font.width(warning) });
        }

        let contentWidth = 0;
        for (const line of lines) {
            contentWidth = Math.max(contentWidth, line.width);
        }

        const boxWidth = contentWidth + 12;
        const contentHeight = lines.length * 10;
        const barHeight = 3;
        const boxHeight = 5 + contentHeight + 3 + barHeight + 4;

        const centerX = context.guiWidth() / 2;
        const top = Math.round(context.guiHeight() / 2 - boxHeight / 2);
        const left = Math.round(centerX - boxWidth / 2);

        context.fill(left, top, left + boxWidth, top + boxHeight, argb(0x99, 0, 0, 0));
        context.fill(left, top, left + boxWidth, top + 1, argb(0x66, 255, Math.round(255 - 170 * ratio), Math.round(90 - 40 * ratio)));

        let lineTop = top + 5;
        for (const line of lines) {
            context.text(font, line.text, Math.round(centerX - line.width / 2), lineTop, line.color, true);
            lineTop += 10;
        }

        const barLeft = left + 6;
        const barRight = left + boxWidth - 6;
        const barTop = top + 5 + contentHeight + 3;
        context.fill(barLeft, barTop, barRight, barTop + barHeight, argb(0x66, 255, 255, 255));
        context.fill(barLeft, barTop, Math.round(barLeft + (barRight - barLeft) * ratio), barTop + barHeight, mainColor);
    });
});
