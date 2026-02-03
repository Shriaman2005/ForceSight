// Initialize Icons
lucide.createIcons();

// DOM Elements
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d'); // Read-only for tracking now
const fbdCanvas = document.getElementById('fbd-canvas');
const fbdCtx = fbdCanvas.getContext('2d');

const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const indicator = document.querySelector('.indicator');

const valNormal = document.getElementById('val-normal');
const valFriction = document.getElementById('val-friction');
const valWeight = document.getElementById('val-weight');
const detectionConf = document.getElementById('detection-confidence');
const fpsCounter = document.getElementById('fps-counter');

// Sliders (Hidden logic mainly, but we can keep them as indicators or manual overrides if needed)
// User wants dynamic, so we'll try to auto-set slope.
const slopeSlider = document.getElementById('slope-slider');
const slopeValueDisp = document.getElementById('slope-value');
const massSlider = document.getElementById('mass-slider');

const massValueDisp = document.getElementById('mass-value');

// Helpers
function updateStatus(text) {
    if (statusText) statusText.innerText = text;
}
function toggleIndicator(active) {
    if (indicator) {
        if (active) indicator.classList.add('active');
        else indicator.classList.remove('active');
    }
}

// State
let isRunning = false;
let objectPos = { x: 0, y: 0, angle: 0, detected: false };
let lastFrameTime = 0;
let physics = {
    mass: 2.0, // kg
    gravity: 9.81,
    detectedSlope: 0, // degrees
    mu: 0.6 // coefficient of friction (rubber/wood)
};

let showMgComponents = true;

const PIXELS_PER_NEWTON = 2; // Scale for FBD

// Calibration (Target Yellow)
let targetColor = { r: 255, g: 215, b: 0 }; // Gold/Yellow
let colorThreshold = 80;

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

// --- Physics Logic ---
function updatePhysics() {
    physics.mass = parseFloat(massSlider.value);

    // Smooth angle (Low pass filter)
    const rawAngle = objectPos.angle; // in radians

    // We assume the object is sitting on a surface. 
    // If the object rotates, the surface rotates.
    // Angle is usually between -PI/2 and PI/2.
    // Convert to degrees for display
    let deg = rawAngle * (180 / Math.PI);

    // Clamp/Deadzone for stability
    if (Math.abs(deg) < 2) deg = 0;

    // Update local physics state
    physics.detectedSlope = deg;

    // Forces
    const theta = (physics.detectedSlope * Math.PI) / 180;

    const weight = physics.mass * physics.gravity; // mg
    const normal = weight * Math.cos(theta); // mg cos(theta)
    const gravityParallel = weight * Math.sin(theta); // mg sin(theta)

    // Friction Calculation
    // Requirement: "show friction forces acting to stop it from sliding"
    // This implies Static Friction holds the object in place until it slips.
    // Static friction matches the parallel component of gravity exactly, up to a max limit.
    const maxStaticFriction = physics.mu * normal;

    let friction = 0;
    let isSliding = false;

    // Direction of friction opposes gravityParallel
    // If gravity pulls down (positive theta -> positive gravityParallel), friction is negative.
    // Magnitude matching:
    if (Math.abs(gravityParallel) <= maxStaticFriction) {
        // Not sliding, friction balances gravity
        friction = gravityParallel;
        isSliding = false;
    } else {
        // Sliding, friction is kinetic (approx equal to max static for this demo)
        friction = maxStaticFriction * Math.sign(gravityParallel);
        isSliding = true;
    }

    return {
        W: weight,
        N: normal,
        f: friction, // Magnitude acts up the slope
        theta: theta,
        sliding: isSliding
    };
}

// --- Computer Vision: Blob & Orientation Tracking ---
function trackObject() {
    if (!ctx || !video) return 0;

    const w = canvas.width;
    const h = canvas.height;

    // Draw current video frame to canvas
    ctx.drawImage(video, 0, 0, w, h);

    // Get pixels
    const frame = ctx.getImageData(0, 0, w, h);
    const data = frame.data;
    const length = data.length;

    // Moments calculation
    let m00 = 0; // count
    let m10 = 0; // sum x
    let m01 = 0; // sum y
    let m11 = 0; // sum xy
    let m20 = 0; // sum x^2
    let m02 = 0; // sum y^2

    const stride = 8; // Performance optimization

    for (let i = 0; i < length; i += 4 * stride) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Color distance
        const dist = Math.sqrt(
            (r - targetColor.r) ** 2 +
            (g - targetColor.g) ** 2 +
            (b - targetColor.b) ** 2
        );

        if (dist < colorThreshold) {
            const index = i / 4;
            const x = index % w;
            const y = Math.floor(index / w);

            m00++;
            m10 += x;
            m01 += y;
            m11 += x * y;
            m20 += x * x;
            m02 += y * y;
        }
    }

    let detected = false;
    let angle = 0;

    if (m00 > 100) { // Detection threshold
        detected = true;
        const xc = m10 / m00;
        const yc = m01 / m00;

        // Central moments
        const mu20 = m20 / m00 - xc * xc;
        const mu02 = m02 / m00 - yc * yc;
        const mu11 = m11 / m00 - xc * yc;

        // Orientation angle
        // 0.5 * atan2(2*mu11, mu20 - mu02)
        // This gives angle of major axis relative to horizontal
        angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);

        objectPos.x = xc;
        objectPos.y = yc;
    }

    objectPos.detected = detected;

    // Smooth angle update (simple lerp)
    if (detected) {
        // Handle wrap around if needed, though for standard slopes it's fine.
        // We might want to limit angle if it jumps too much.
        const alpha = 0.1;
        objectPos.angle = objectPos.angle * (1 - alpha) + angle * alpha;
    } else {
        // Drift back to 0 if lost? Or stay?
        // objectPos.angle = 0; 
    }

    return m00;
}

// --- Visualization Helpers ---
function drawArrow(context, fromX, fromY, vecX, vecY, color, label, isDashed = false) {
    const toX = fromX + vecX;
    const toY = fromY + vecY;

    const headLen = 12;
    const angle = Math.atan2(vecY, vecX);

    context.strokeStyle = color;
    context.lineWidth = 4;
    context.lineCap = "round";

    context.beginPath();
    if (isDashed) {
        context.setLineDash([5, 5]);
    } else {
        context.setLineDash([]);
    }
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.setLineDash([]); // Reset

    // Head
    context.beginPath();
    context.moveTo(toX, toY);
    context.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
    context.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
    context.lineTo(toX, toY);
    context.fillStyle = color;
    context.fill();

    // Label
    if (label) {
        context.font = "bold 14px 'Space Grotesk'";
        context.fillStyle = "white"; // Or color
        // Offset label slightly
        context.fillText(label, toX + (vecX > 0 ? 10 : -30), toY + (vecY > 0 ? 25 : -10));
    }
}

// --- Main Loop ---
function loop(timestamp) {
    if (!isRunning) return;

    // FPS
    const dt = timestamp - lastFrameTime;
    lastFrameTime = timestamp;
    fpsCounter.innerText = Math.round(1000 / dt) || 60;

    // 1. Vision
    const pixelCount = trackObject();

    // 2. Physics
    const forces = updatePhysics();

    // 3. UI Updates
    // Clear Overlay - We only show clean video + maybe bounding box
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Show bounding circle only to indicate "Tracking" is working, but no forces
    if (objectPos.detected) {
        ctx.strokeStyle = "rgba(255, 215, 0, 0.8)"; // Yellow ring
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Draw ellipse along major axis
        ctx.save();
        ctx.translate(objectPos.x, objectPos.y);
        ctx.rotate(objectPos.angle);
        ctx.ellipse(0, 0, 40, 30, 0, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);

        detectionConf.innerText = "Tracking Yellow Cube";
        detectionConf.style.color = "#4ade80"; // green
    } else {
        detectionConf.innerText = "Searching for Yellow...";
        detectionConf.style.color = "#facc15"; // yellow
    }

    // Updates
    slopeSlider.value = physics.detectedSlope.toFixed(1); // update slider to match reality
    slopeValueDisp.innerText = physics.detectedSlope.toFixed(1) + "°";

    valNormal.innerText = forces.N.toFixed(1) + " N";
    valWeight.innerText = forces.W.toFixed(1) + " N";
    valFriction.innerText = Math.abs(forces.f).toFixed(1) + " N";

    // Bars
    const maxVal = 50;
    document.querySelector('.normal .fill').style.width = Math.min(100, (forces.N / maxVal) * 100) + "%";
    document.querySelector('.friction .fill').style.width = Math.min(100, (Math.abs(forces.f) / maxVal) * 100) + "%";
    document.querySelector('.weight .fill').style.width = Math.min(100, (forces.W / maxVal) * 100) + "%";

    // 4. FBD Visualization (Right Panel)
    drawFBD(forces);

    requestAnimationFrame(loop);
}

function drawFBD(forces) {
    // Canvas setup
    fbdCanvas.width = fbdCanvas.clientWidth;
    fbdCanvas.height = fbdCanvas.clientHeight;
    const cx = fbdCanvas.width / 2;
    const cy = fbdCanvas.height / 2;
    const ctx = fbdCtx;

    // Scale for drawing
    const scale = 2.5;

    // We want to draw the surface tilted by forces.theta
    // But Force Vectors should be drawn relative to the object/surface logic.
    // Let's rotate the whole view to match the detected angle

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.5, 1.5); // Enlarge the view

    // Apply Rotation (Visual tilt)
    // Note: The object rotates in the video. We mimic that here.
    // If slope > 0 (tilted right/down), theta is positive.
    ctx.rotate(forces.theta);

    // Draw Surface
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-150, 25); // moved down slightly
    ctx.lineTo(150, 25);
    ctx.stroke();

    // Draw Cube
    ctx.fillStyle = "rgba(255, 215, 0, 0.9)"; // Yellow
    ctx.shadowBlur = 15;
    ctx.shadowColor = "black";
    ctx.fillRect(-25, -25, 50, 50);
    ctx.shadowBlur = 0;

    // --- Draw Vectors --- 
    // Origin is center of square (0,0)

    // Normal Force (Perpendicular to surface, i.e., UP in local rotated frame)
    // Vector: (0, -N)
    drawArrow(ctx, 0, -25, 0, -forces.N * scale, "#06b6d4", "N");

    // Weight (Always DOWN in GLOBAL frame)
    // We will draw it normally, but also its components.

    // 1. Draw Real Weight Vector (slightly transparent to emphasize components)
    ctx.save();
    ctx.rotate(-forces.theta);

    // If components are hidden, we show the main Weight vector fully opaque and labeled.
    // If components are shown, we keep it ghosted (transparent) and unlabeled to reduce clutter.
    const wColor = showMgComponents ? "rgba(239, 68, 68, 0.5)" : "rgba(239, 68, 68, 1.0)";
    const wLabel = showMgComponents ? "" : "mg";

    drawArrow(ctx, 0, 0, 0, forces.W * scale, wColor, wLabel);
    ctx.restore();

    // 2. Weight Components
    if (showMgComponents) {
        // mg cos(theta) -> Perpendicular into slope
        // Direction: (0, 1) in local frame
        // Magnitude: W * cos(theta) (which is Normal force magnitude roughly)
        const wCos = forces.W * Math.cos(forces.theta);
        drawArrow(ctx, 0, 0, 0, wCos * scale, "#a855f7", "mg cosθ", true);

        // mg sin(theta) -> Parallel to slope
        // Direction: Down the slope.
        // If theta > 0, pulls +x.
        const wSin = forces.W * Math.sin(forces.theta);
        drawArrow(ctx, 0, 0, wSin * scale, 0, "#ec4899", "mg sinθ", true);
    }


    // Friction (Parallel to surface)
    // Direction: Opposes sliding tendency.
    if (Math.abs(forces.f) > 0.1) {
        let dir = (forces.theta > 0) ? -1 : 1;
        drawArrow(ctx, 0, 25, dir * Math.abs(forces.f) * scale, 0, "#f59e0b", "f");
    }

    ctx.restore();
}

// Events
document.getElementById('toggle-camera').addEventListener('click', () => {
    if (!isRunning) startCamera();
});

document.getElementById('calibrate-btn').addEventListener('click', () => {
    if (!isRunning) return;

    // Calibrate simplified center color
    const cx = Math.floor(video.videoWidth / 2);
    const cy = Math.floor(video.videoHeight / 2);

    const tCanvas = document.createElement('canvas');
    tCanvas.width = video.videoWidth;
    tCanvas.height = video.videoHeight;
    const tCtx = tCanvas.getContext('2d');
    tCtx.drawImage(video, 0, 0, tCanvas.width, tCanvas.height);

    const p = tCtx.getImageData(cx, cy, 1, 1).data;
    targetColor = { r: p[0], g: p[1], b: p[2] };
    updateStatus(`Observed: ${p[0]}, ${p[1]}, ${p[2]}`);

    // Reset to active after short delay
    setTimeout(() => { updateStatus("Tracking Active"); }, 1500);
});

document.getElementById('export-btn').addEventListener('click', () => {
    // Determine current angle
    const angle = physics.detectedSlope.toFixed(0);
    const link = document.createElement('a');
    link.download = `FBD_Angle_${angle}.png`;
    link.href = fbdCanvas.toDataURL('image/png');
    link.click();
});

document.getElementById('toggle-mg-btn').addEventListener('click', () => {
    showMgComponents = !showMgComponents;
    // Optional: Visual feedback on button (e.g., opacity or border)
    const btn = document.getElementById('toggle-mg-btn');
    if (showMgComponents) {
        btn.style.opacity = "1";
    } else {
        btn.style.opacity = "0.5";
    }
});

// Init
startCamera();
