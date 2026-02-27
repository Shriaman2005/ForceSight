// Initialize Icons
lucide.createIcons();

// DOM Elements
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d'); // Read-only tracking + overlay
const fbdCanvas = document.getElementById('fbd-canvas');
const fbdCtx = fbdCanvas.getContext('2d');

const statusText = document.getElementById('status-text');
const indicator = document.querySelector('.indicator');

const valNormal = document.getElementById('val-normal');
const valFriction = document.getElementById('val-friction');
const valWeight = document.getElementById('val-weight');
const detectionConf = document.getElementById('detection-confidence');
const fpsCounter = document.getElementById('fps-counter');

const slopeSlider = document.getElementById('slope-slider');
const slopeValueDisp = document.getElementById('slope-value');
const massSlider = document.getElementById('mass-slider');
const massValueDisp = document.getElementById('mass-value');
const frictionSlider = document.getElementById('friction-slider');
const frictionValueDisp = document.getElementById('friction-value');

const mass2Slider = document.getElementById('mass2-slider');
const mass2ValueDisp = document.getElementById('mass2-value');
const friction2Slider = document.getElementById('friction2-slider');
const friction2ValueDisp = document.getElementById('friction2-value');

const frictionName = document.querySelector('.friction .force-name');

// Helpers
function updateStatus(text) {
    if (statusText) statusText.innerText = text;
}

function toggleIndicator(active) {
    if (!indicator) return;
    if (active) indicator.classList.add('active');
    else indicator.classList.remove('active');
}

// State
let isRunning = false;
let lastFrameTime = 0;

let physics = {
    mass: 2.0,
    mu: 0.6,
    mass2: 2.0,
    mu2: 0.6,
    gravity: 9.81,
    detectedSlope: 0, // degrees
};

let showMgComponents = true;

const trackState = {
    yellow: { x: 0, y: 0, angle: 0, detected: false, area: 0 },
    red: { x: 0, y: 0, angle: 0, detected: false, area: 0 }
};

// Tracking constants
const TRACK_STRIDE = 8;
const MIN_DETECTION_PIXELS = 90;

// Calibration (Yellow is primary object)
let yellowTargetColor = { r: 255, g: 215, b: 0 };
let yellowThreshold = 80;
let redTargetColor = { r: 139, g: 0, b: 0 };
let redThreshold = 95;

// --- Camera Setup ---
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' }
        });

        video.srcObject = stream;
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            isRunning = true;
            updateStatus("Tracking Active");
            toggleIndicator(true);
            requestAnimationFrame(loop);
        };
    } catch (err) {
        console.error("Camera Error:", err);
        updateStatus("Camera Error");
        alert("Could not access camera. Please ensure permissions are granted.");
    }
}

// --- Math Helpers ---
function shortestAngleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// --- Physics Logic ---
function updatePhysics() {
    physics.mass = parseFloat(massSlider.value);
    massValueDisp.innerText = physics.mass.toFixed(1) + " kg";

    physics.mu = parseFloat(frictionSlider.value);
    frictionValueDisp.innerText = physics.mu.toFixed(2);

    let rawAngle = 0;
    if (trackState.yellow.detected) {
        rawAngle = trackState.yellow.angle;
    } else if (trackState.red.detected) {
        rawAngle = trackState.red.angle;
    }

    let deg = rawAngle * (180 / Math.PI);
    if (Math.abs(deg) < 2) deg = 0;
    physics.detectedSlope = deg;

    let activeMass = trackState.primary === 'red' ? physics.mass2 : physics.mass;
    let activeMu = trackState.primary === 'red' ? physics.mu2 : physics.mu;

    const theta = (physics.detectedSlope * Math.PI) / 180;
    const weight = activeMass * physics.gravity;
    const normal = Math.max(0, weight * Math.cos(theta));
    const gravityParallel = weight * Math.sin(theta);
    const maxStaticFriction = activeMu * normal;

    let friction = 0;
    let isSliding = false;

    if (Math.abs(gravityParallel) <= maxStaticFriction) {
        friction = gravityParallel;
    } else {
        friction = maxStaticFriction * Math.sign(gravityParallel);
        isSliding = true;
    }

    return {
        W: weight,
        N: normal,
        f: friction,
        theta: theta,
        sliding: isSliding
    };
}

// --- Computer Vision: Dual Color Tracking ---
function colorDistanceSq(r, g, b, target) {
    return (
        (r - target.r) * (r - target.r) +
        (g - target.g) * (g - target.g) +
        (b - target.b) * (b - target.b)
    );
}

function initMoments() {
    return { m00: 0, m10: 0, m01: 0, m11: 0, m20: 0, m02: 0 };
}

function accumulateMoments(m, x, y) {
    m.m00++;
    m.m10 += x;
    m.m01 += y;
    m.m11 += x * y;
    m.m20 += x * x;
    m.m02 += y * y;
}

function finalizeTrack(moments, track) {
    if (moments.m00 <= MIN_DETECTION_PIXELS) {
        track.detected = false;
        track.area = 0;
        return;
    }

    const xc = moments.m10 / moments.m00;
    const yc = moments.m01 / moments.m00;

    const mu20 = moments.m20 / moments.m00 - xc * xc;
    const mu02 = moments.m02 / moments.m00 - yc * yc;
    const mu11 = moments.m11 / moments.m00 - xc * yc;
    const angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);

    const alpha = 0.16;
    track.x = xc;
    track.y = yc;
    track.angle = track.angle * (1 - alpha) + angle * alpha;
    track.detected = true;
    track.area = moments.m00;
}

function trackObjects() {
    if (!ctx || !video) return { yellowPixels: 0, redPixels: 0 };

    const w = canvas.width;
    const h = canvas.height;

    ctx.drawImage(video, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    const data = frame.data;

    const yellowMoments = initMoments();
    const redMoments = initMoments();

    const yellowThresholdSq = yellowThreshold * yellowThreshold;
    const redThresholdSq = redThreshold * redThreshold;

    for (let i = 0; i < data.length; i += 4 * TRACK_STRIDE) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const dYellow = colorDistanceSq(r, g, b, yellowTargetColor);
        const dRed = colorDistanceSq(r, g, b, redTargetColor);

        const isYellow = dYellow < yellowThresholdSq;
        const isRed = dRed < redThresholdSq;

        if (!isYellow && !isRed) continue;

        const index = i / 4;
        const x = index % w;
        const y = Math.floor(index / w);

        if (isYellow && (!isRed || dYellow <= dRed)) {
            accumulateMoments(yellowMoments, x, y);
        } else if (isRed) {
            accumulateMoments(redMoments, x, y);
        }
    }

    finalizeTrack(yellowMoments, trackState.yellow);
    finalizeTrack(redMoments, trackState.red);

    return {
        yellowPixels: yellowMoments.m00,
        redPixels: redMoments.m00
    };
}

// --- Interaction Logic ---
function computeBlockInteraction(forces) {
    const yellow = trackState.yellow;
    const red = trackState.red;

    if (!yellow.detected || !red.detected) {
        return {
            bothDetected: false,
            active: false,
            touching: false,
            mode: 'none',
            normal: { x: 0, y: 0 },
            magnitude: 0,
            angleDiff: 0,
            distance: 0
        };
    }

    const dx = red.x - yellow.x;
    const dy = red.y - yellow.y;
    const distance = Math.hypot(dx, dy) || 1;

    let mode = 'angled';
    let normal = { x: dx / distance, y: dy / distance };

    if (Math.abs(dy) > Math.abs(dx) * 1.25) {
        mode = 'stacked';
        normal = { x: 0, y: Math.sign(dy) || 1 };
    } else if (Math.abs(dx) > Math.abs(dy) * 1.25) {
        mode = 'side';
        normal = { x: Math.sign(dx) || 1, y: 0 };
    }

    const angleDiff = Math.abs(shortestAngleDiff(red.angle, yellow.angle));
    const surfaceAlignment = clamp(Math.cos(angleDiff), 0.2, 1.0);
    const upperWeight = physics.mass2 * physics.gravity; // Red's weight pressing down
    const slopeDrive = Math.abs(forces.W * Math.sin(forces.theta));

    let magnitude = 0;
    let frictionMagnitude = 0;
    if (mode === 'stacked') {
        magnitude = upperWeight * surfaceAlignment;
        frictionMagnitude = physics.mu * magnitude;
    } else if (mode === 'side') {
        magnitude = (slopeDrive + Math.abs(forces.f)) * surfaceAlignment;
        frictionMagnitude = physics.mu * magnitude;
    } else {
        const compressionFromGravity = Math.abs(upperWeight * normal.y);
        const compressionFromSlope = Math.abs(physics.mass2 * physics.gravity * Math.sin(forces.theta)) * Math.abs(normal.x);
        magnitude = (compressionFromGravity + compressionFromSlope) * surfaceAlignment;
        frictionMagnitude = physics.mu2 * magnitude;
    }

    const dynamicContactDistance = clamp(
        (Math.sqrt(Math.max(1, yellow.area)) + Math.sqrt(Math.max(1, red.area))) * 3.2,
        110,
        230
    );

    const touching = distance <= dynamicContactDistance;
    if (!touching) magnitude = 0;

    return {
        bothDetected: true,
        active: touching,
        touching: touching,
        mode: mode,
        normal: normal,
        magnitude: magnitude,
        frictionMagnitude: frictionMagnitude,
        angleDiff: angleDiff,
        distance: distance
    };
}

// --- Visualization Helpers ---
function drawArrow(context, fromX, fromY, vecX, vecY, color, label, isDashed = false) {
    const toX = fromX + vecX;
    const toY = fromY + vecY;
    const headLen = 12;
    const angle = Math.atan2(vecY, vecX);

    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 4;
    context.lineCap = "round";

    context.beginPath();
    context.setLineDash(isDashed ? [5, 5] : []);
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.setLineDash([]);

    context.beginPath();
    context.moveTo(toX, toY);
    context.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
    context.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();

    if (label) {
        context.font = "bold 14px 'Space Grotesk'";
        context.fillStyle = "#0f172a";
        context.fillText(label, toX + (vecX >= 0 ? 10 : -34), toY + (vecY >= 0 ? 20 : -10));
    }
}

function drawTrackedBlock(track, color, label) {
    if (!track.detected) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.translate(track.x, track.y);
    ctx.rotate(track.angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, 40, 30, 0, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.font = "bold 13px 'Space Grotesk'";
    ctx.fillText(label, track.x + 16, track.y - 16);
}

function drawContactGuide(interaction) {
    if (!interaction.bothDetected) return;

    const y = trackState.yellow;
    const r = trackState.red;

    ctx.save();
    ctx.strokeStyle = interaction.active ? "rgba(34,197,94,0.85)" : "rgba(148,163,184,0.8)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(y.x, y.y);
    ctx.lineTo(r.x, r.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
}

function drawCube(context, x, y, size, color) {
    context.save();
    context.fillStyle = color;
    context.shadowBlur = 12;
    context.shadowColor = "rgba(15,23,42,0.45)";
    context.fillRect(x - size / 2, y - size / 2, size, size);
    context.shadowBlur = 0;
    context.restore();
}

function drawAngleArc(context, x, y, radius, angle, color) {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    // Arc from horizontal base (0) to -angle (since positive angle is slope down)
    context.arc(x, y, radius, 0, -angle, angle > 0);
    context.stroke();

    context.fillStyle = color;
    context.font = "bold 12px 'Space Grotesk'";
    const labelX = x + (radius + 15) * Math.cos(-angle / 2);
    const labelY = y + (radius + 15) * Math.sin(-angle / 2);
    context.fillText("θ", labelX, labelY);
    context.restore();
}

function drawWeightVector(context, forces, x, y, label) {
    context.save();
    context.translate(x, y);
    context.rotate(-forces.theta);
    drawArrow(context, 0, 0, 0, forces.W * 2.2, "#ef4444", label);
    context.restore();
}

function setupFBD(forces) {
    fbdCanvas.width = fbdCanvas.clientWidth;
    fbdCanvas.height = fbdCanvas.clientHeight;

    const cx = fbdCanvas.width / 2;
    const cy = fbdCanvas.height / 2;

    fbdCtx.clearRect(0, 0, fbdCanvas.width, fbdCanvas.height);
    fbdCtx.save();
    fbdCtx.translate(cx, cy);
    fbdCtx.scale(1.5, 1.5);
    fbdCtx.rotate(forces.theta);

    fbdCtx.strokeStyle = "rgba(0,0,0,0.6)";
    fbdCtx.lineWidth = 4;
    fbdCtx.beginPath();
    fbdCtx.moveTo(-155, 25);
    fbdCtx.lineTo(155, 25);
    fbdCtx.stroke();
}

function drawSingleFBD(forces) {
    setupFBD(forces);

    let primaryColor = trackState.primary === 'red' ? "rgba(139, 0, 0, 0.9)" : "rgba(255, 215, 0, 0.9)";
    drawCube(fbdCtx, 0, 0, cubeSize, primaryColor);

    // Draw angle theta arc at the base
    drawAngleArc(fbdCtx, -130, 25, 40, forces.theta, "#64748b");

    const scale = 2.5;
    drawArrow(fbdCtx, 0, -cubeSize / 2, 0, -forces.N * scale, "#06b6d4", "N");
    drawWeightVector(fbdCtx, forces, 0, 0, "mg");

    if (showMgComponents) {
        const wCos = forces.W * Math.cos(forces.theta);
        const wSin = forces.W * Math.sin(forces.theta);
        drawArrow(fbdCtx, 0, 0, 0, wCos * scale, "#a855f7", "mg cosθ", true);
        drawArrow(fbdCtx, 0, 0, wSin * scale, 0, "#ec4899", "mg sinθ", true);
    }

    if (Math.abs(forces.f) > 0.1) {
        const dir = (forces.theta > 0) ? -1 : 1;
        drawArrow(fbdCtx, 0, cubeSize / 2, dir * Math.abs(forces.f) * scale, 0, "#f59e0b", "f");
    }

    fbdCtx.restore();
}

function drawMultiBlockFBD(forces, interaction) {
    setupFBD(forces);

    const cubeSize = 46;
    const gap = 6;

    const yellowPos = { x: 0, y: 0 };
    let redPos = { x: interaction.normal.x * (cubeSize + gap), y: interaction.normal.y * (cubeSize + gap) };

    if (interaction.mode === 'stacked') {
        redPos = { x: 0, y: -cubeSize - gap };
    } else if (interaction.mode === 'side') {
        redPos = { x: (interaction.normal.x > 0 ? 1 : -1) * (cubeSize + gap), y: 0 };
    }

    drawCube(fbdCtx, yellowPos.x, yellowPos.y, cubeSize, "rgba(255, 215, 0, 0.9)");
    drawCube(fbdCtx, redPos.x, redPos.y, cubeSize, "rgba(227, 3, 3, 0.9)");

    // Draw angle theta arc
    drawAngleArc(fbdCtx, -135, 25, 35, forces.theta, "#64748b");

    const mainScale = 2.1;
    drawArrow(fbdCtx, yellowPos.x, yellowPos.y - cubeSize / 2, 0, -forces.N * mainScale, "#06b6d4", "N");
    drawWeightVector(fbdCtx, forces, yellowPos.x, yellowPos.y, "mg_y");
    drawWeightVector(fbdCtx, forces, redPos.x, redPos.y, "mg_r");

    const reactionScale = 2.4;
    const rx = interaction.normal.x * interaction.magnitude * reactionScale;
    const ry = interaction.normal.y * interaction.magnitude * reactionScale;

    drawArrow(fbdCtx, yellowPos.x, yellowPos.y, -rx, -ry, "#22c55e", "F cosθ");
    drawArrow(fbdCtx, redPos.x, redPos.y, rx, ry, "#0ea5e9", "F sinθ");

    // Add inter-block friction (opposing relative motion)
    if (interaction.frictionMagnitude > 0.5) {
        const fScale = 2.0;
        // Simplified direction: opposing slope component of red block
        const fDir = (forces.theta > 0) ? -1 : 1;
        drawArrow(fbdCtx, redPos.x, redPos.y + cubeSize / 2, fDir * interaction.frictionMagnitude * fScale, 0, "#f59e0b", "f_inter");
    }

    fbdCtx.save();
    fbdCtx.rotate(-forces.theta);
    fbdCtx.fillStyle = "#0f172a";
    fbdCtx.font = "bold 13px 'Space Grotesk'";
    fbdCtx.fillText(
        `${interaction.mode} contact | Δθ ${(interaction.angleDiff * 180 / Math.PI).toFixed(1)}°`,
        -120,
        -110
    );
    fbdCtx.restore();

    fbdCtx.restore();
}

function drawFBD(forces, interaction) {
    if (interaction.active) drawMultiBlockFBD(forces, interaction);
    else drawSingleFBD(forces);
}

function updateDetectionText(interaction) {
    const hasYellow = trackState.yellow.detected;
    const hasRed = trackState.red.detected;

    if (hasYellow && interaction.active) {
        detectionConf.innerText = `Yellow + Red (${interaction.mode} contact)`;
        detectionConf.style.color = "#22c55e";
        return;
    }

    if (hasYellow && hasRed && !interaction.active) {
        detectionConf.innerText = "Yellow + Red detected (move blocks closer)";
        detectionConf.style.color = "#f59e0b";
        return;
    }

    if (hasYellow) {
        detectionConf.innerText = "Tracking Yellow Cube";
        detectionConf.style.color = "#4ade80";
        return;
    }

    if (hasRed) {
        detectionConf.innerText = "Red cube found (waiting for yellow)";
        detectionConf.style.color = "#fb7185";
        return;
    }

    detectionConf.innerText = "Searching for Yellow...";
    detectionConf.style.color = "#facc15";
}

// --- Main Loop ---
function loop(timestamp) {
    if (!isRunning) return;

    const dt = timestamp - lastFrameTime;
    lastFrameTime = timestamp;
    fpsCounter.innerText = Math.round(1000 / dt) || 60;

    trackObjects();
    const forces = updatePhysics();
    const interaction = computeBlockInteraction(forces);

    // Overlay above live video
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawTrackedBlock(trackState.yellow, "rgba(255, 215, 0, 0.9)", "Yellow");
    drawTrackedBlock(trackState.red, "rgba(139, 0, 0, 0.9)", "Red");
    drawContactGuide(interaction);

    // FBD display driven by either block
    const noObjectMsg = document.getElementById('no-object-message');
    const forcesList = document.querySelector('.forces-list');

    const anyBlockDetected = trackState.yellow.detected || trackState.red.detected;

    if (anyBlockDetected) {
        fbdCanvas.style.display = 'block';
        noObjectMsg.style.display = 'none';
        forcesList.style.display = 'flex';
    } else {
        fbdCanvas.style.display = 'none';
        noObjectMsg.style.display = 'flex';
        forcesList.style.display = 'none';
    }

    slopeSlider.value = clamp(physics.detectedSlope, -45, 45).toFixed(1);
    slopeValueDisp.innerText = physics.detectedSlope.toFixed(1) + "°";

    valNormal.innerText = forces.N.toFixed(1) + " N";
    valWeight.innerText = forces.W.toFixed(1) + " N";

    let thirdForceMagnitude = Math.abs(forces.f);
    if (interaction.active) {
        frictionName.innerText = "Reaction (R)";
        thirdForceMagnitude = interaction.magnitude;
    } else {
        frictionName.innerText = "Friction (f)";
    }

    valFriction.innerText = thirdForceMagnitude.toFixed(1) + " N";

    const maxVal = 50;
    document.querySelector('.normal .fill').style.width = Math.min(100, (forces.N / maxVal) * 100) + "%";
    document.querySelector('.friction .fill').style.width = Math.min(100, (thirdForceMagnitude / maxVal) * 100) + "%";
    document.querySelector('.weight .fill').style.width = Math.min(100, (forces.W / maxVal) * 100) + "%";

    if (anyBlockDetected) drawFBD(forces, interaction);
    updateDetectionText(interaction);

    requestAnimationFrame(loop);
}

// Events
document.getElementById('toggle-camera').addEventListener('click', () => {
    if (!isRunning) startCamera();
});

document.getElementById('calibrate-btn').addEventListener('click', () => {
    if (!isRunning) return;

    const cx = Math.floor(video.videoWidth / 2);
    const cy = Math.floor(video.videoHeight / 2);

    const tCanvas = document.createElement('canvas');
    tCanvas.width = video.videoWidth;
    tCanvas.height = video.videoHeight;
    const tCtx = tCanvas.getContext('2d');
    tCtx.drawImage(video, 0, 0, tCanvas.width, tCanvas.height);

    const p = tCtx.getImageData(cx, cy, 1, 1).data;
    yellowTargetColor = { r: p[0], g: p[1], b: p[2] };
    updateStatus(`Yellow target: ${p[0]}, ${p[1]}, ${p[2]}`);
    setTimeout(() => updateStatus("Tracking Active"), 1500);
});

document.getElementById('export-btn').addEventListener('click', () => {
    const angle = physics.detectedSlope.toFixed(0);
    const link = document.createElement('a');
    link.download = `FBD_Angle_${angle}.png`;
    link.href = fbdCanvas.toDataURL('image/png');
    link.click();
});

document.getElementById('toggle-mg-btn').addEventListener('click', () => {
    showMgComponents = !showMgComponents;
    const btn = document.getElementById('toggle-mg-btn');
    btn.style.opacity = showMgComponents ? "1" : "0.5";
});

const settingsBtn = document.getElementById('settings-btn');
const controlsSection = document.querySelector('.controls-section');

settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    controlsSection.classList.toggle('active');
    settingsBtn.classList.toggle('active');
});

document.addEventListener('click', (e) => {
    if (!controlsSection.contains(e.target) && !settingsBtn.contains(e.target)) {
        controlsSection.classList.remove('active');
        settingsBtn.classList.remove('active');
    }
});

// Init
startCamera();
