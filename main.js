// WebGL2 Olasılıksal Yerçekimi Simülasyonu
// Main Script

const canvas = document.getElementById('glCanvas');
const gl = canvas.getContext('webgl2');

if (!gl) {
    alert('WebGL2 desteklenmiyor!');
    throw new Error('WebGL2 not supported');
}

// UI Elements
const particleCountSlider = document.getElementById('particleCount');
const particleCountVal = document.getElementById('particleCountVal');
const updateSpeedSlider = document.getElementById('updateSpeed');
const updateSpeedVal = document.getElementById('updateSpeedVal');
const toggleBtn = document.getElementById('toggleBtn');
const restartBtn = document.getElementById('restartBtn');
const gravityBtn = document.getElementById('gravityBtn');
const gravityStrengthSlider = document.getElementById('gravityStrength');
const gravityStrengthVal = document.getElementById('gravityStrengthVal');
const gravityTypeSelect = document.getElementById('gravityType');


// State
let particles = []; // Float32Array [x, y, x, y, ...]
let particleCount = 100;
let updateInterval = 10;
let lastUpdateTime = 0;
let isRunning = false;
let animationId = null;

// Gravity State
let isGravityActive = false;
let gravityObjects = []; // Array of objects with type: 'point', 'line', 'polygon'
let gravityStrengthBase = 200.0;

// Particle Gravity (inter-particle attraction/repulsion) State
let isParticleAttractEnabled = false;
let isParticleRepulseEnabled = false;
let particleGravityStrength = 50.0;
const GRID_CELL_SIZE = 20; // pixels per grid cell
let gridCols = 0;
let gridRows = 0;
let grid = null;       // Int32Array - flat grid storing particle counts per cell
let gridMassX = null;  // Float32Array - sum of X positions per cell
let gridMassY = null;  // Float32Array - sum of Y positions per cell

function initGrid() {
    gridCols = Math.ceil(canvas.width / GRID_CELL_SIZE);
    gridRows = Math.ceil(canvas.height / GRID_CELL_SIZE);
    const totalCells = gridCols * gridRows;
    grid = new Int32Array(totalCells);
    gridMassX = new Float32Array(totalCells);
    gridMassY = new Float32Array(totalCells);
}

function buildGrid() {
    grid.fill(0);
    gridMassX.fill(0);
    gridMassY.fill(0);

    for (let i = 0; i < particleCount; i++) {
        const px = particles[i * 2];
        const py = particles[i * 2 + 1];
        const col = Math.min(Math.floor(px / GRID_CELL_SIZE), gridCols - 1);
        const row = Math.min(Math.floor(py / GRID_CELL_SIZE), gridRows - 1);
        const idx = row * gridCols + col;
        grid[idx]++;
        gridMassX[idx] += px;
        gridMassY[idx] += py;
    }
}

// Interaction State
let isDrawing = false;
let drawStart = { x: 0, y: 0 };
let currentDrawShape = null; // Temporary shape being drawn

// Shader Program (Render)
const vsSource = `#version 300 es
in vec2 a_position;
uniform vec2 u_resolution;
uniform float u_pointSize;

void main() {
    // Convert pixels to clip space (-1 to +1)
    vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
    gl_PointSize = u_pointSize;
}
`;

const fsSource = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;

void main() {
    outColor = u_color;
}
`;

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl, vs, fs) {
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        return null;
    }
    return program;
}

const renderProgram = createProgram(gl,
    createShader(gl, gl.VERTEX_SHADER, vsSource),
    createShader(gl, gl.FRAGMENT_SHADER, fsSource)
);

const positionLoc = gl.getAttribLocation(renderProgram, 'a_position');
const resolutionLoc = gl.getUniformLocation(renderProgram, 'u_resolution');
const colorLoc = gl.getUniformLocation(renderProgram, 'u_color');
const pointSizeLoc = gl.getUniformLocation(renderProgram, 'u_pointSize');

// Buffers
const positionBuffer = gl.createBuffer();
const vao = gl.createVertexArray();

gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.enableVertexAttribArray(positionLoc);
gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

// Helper Functions
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}


function initSystem() {
    particleCount = parseInt(particleCountSlider.value);
    particleCountVal.textContent = particleCount;
    updateSpeedVal.textContent = updateSpeedSlider.value;
    updateInterval = parseInt(updateSpeedSlider.value);

    particles = new Float32Array(particleCount * 2);
    for (let i = 0; i < particleCount; i++) {
        particles[i * 2] = randomInt(0, canvas.width - 1);
        particles[i * 2 + 1] = randomInt(0, canvas.height - 1);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, particles, gl.DYNAMIC_DRAW);

    gl.viewport(0, 0, canvas.width, canvas.height);

    initGrid();
}

function updateParticles() {
    const neighborOffsets = [
        { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
        { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
        { dx: -1, dy: 1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 }
    ];

    // Build spatial grid if any particle interaction is active
    const particleInteractionActive = isGravityActive && (isParticleAttractEnabled || isParticleRepulseEnabled);
    if (particleInteractionActive) {
        buildGrid();
    }

    for (let i = 0; i < particleCount; i++) {
        let x = particles[i * 2];
        let y = particles[i * 2 + 1];

        let weights = [1, 1, 1, 1, 1, 1, 1, 1];
        let totalWeight = 8;

        // 1. User-placed gravity points
        if (isGravityActive && gravityObjects.length > 0) {
            for (const obj of gravityObjects) {
                let gx = obj.x - x;
                let gy = obj.y - y;
                let dist = Math.hypot(gx, gy);

                if (dist < 1) dist = 1;

                let dirX = gx / dist;
                let dirY = gy / dist;

                if (obj.type === 'repulse') {
                    dirX = -dirX;
                    dirY = -dirY;
                }

                let strength = (gravityStrengthBase * 5.0) / dist;

                for (let k = 0; k < 8; k++) {
                    const dot = dirX * neighborOffsets[k].dx + dirY * neighborOffsets[k].dy;
                    if (dot > 0) {
                        weights[k] += strength * dot;
                    }
                }
            }
        }

        // 2. Inter-particle gravity/repulsion via spatial grid
        if (particleInteractionActive) {
            const col = Math.min(Math.floor(x / GRID_CELL_SIZE), gridCols - 1);
            const row = Math.min(Math.floor(y / GRID_CELL_SIZE), gridRows - 1);

            // Check 5x5 neighborhood of grid cells for smoother influence
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    const nr = row + dr;
                    const nc = col + dc;
                    if (nr < 0 || nr >= gridRows || nc < 0 || nc >= gridCols) continue;

                    const cellIdx = nr * gridCols + nc;
                    const count = grid[cellIdx];
                    if (count === 0) continue;

                    // Center of mass of this cell
                    const cmx = gridMassX[cellIdx] / count;
                    const cmy = gridMassY[cellIdx] / count;

                    let gx = cmx - x;
                    let gy = cmy - y;
                    let dist = Math.hypot(gx, gy);

                    if (dist < 1) continue; // Skip self / too close

                    let dirX = gx / dist;
                    let dirY = gy / dist;

                    // Strength scales with particle count in cell, inversely with distance
                    let strength = (particleGravityStrength * count) / (dist * dist);

                    // Apply attract
                    if (isParticleAttractEnabled) {
                        for (let k = 0; k < 8; k++) {
                            const dot = dirX * neighborOffsets[k].dx + dirY * neighborOffsets[k].dy;
                            if (dot > 0) {
                                weights[k] += strength * dot;
                            }
                        }
                    }

                    // Apply repulse (invert direction)
                    if (isParticleRepulseEnabled) {
                        for (let k = 0; k < 8; k++) {
                            const dot = (-dirX) * neighborOffsets[k].dx + (-dirY) * neighborOffsets[k].dy;
                            if (dot > 0) {
                                weights[k] += strength * dot;
                            }
                        }
                    }
                }
            }
        }

        if (isGravityActive || particleInteractionActive) {
            totalWeight = weights.reduce((a, b) => a + b, 0);
        }

        // Weighted Random
        let r = Math.random() * totalWeight;
        let selectedNeighbor = -1;
        let cumulative = 0;
        for (let k = 0; k < 8; k++) {
            cumulative += weights[k];
            if (r < cumulative) {
                selectedNeighbor = k;
                break;
            }
        }

        if (selectedNeighbor !== -1) {
            x += neighborOffsets[selectedNeighbor].dx;
            y += neighborOffsets[selectedNeighbor].dy;
        }

        if (x < 0) x = 0;
        if (x >= canvas.width) x = canvas.width - 1;
        if (y < 0) y = 0;
        if (y >= canvas.height) y = canvas.height - 1;

        particles[i * 2] = x;
        particles[i * 2 + 1] = y;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, particles);
}

// Counter State
let isCounterActive = false;
let counterRadius = 100;
let mousePos = { x: -1000, y: -1000 };
let particlesInRadius = 0;

// ... (existing code) ...

function render() {
    // ... (existing render code until gravity points drawn) ...
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(renderProgram);
    gl.uniform2f(resolutionLoc, canvas.width, canvas.height);

    // 1. Draw Particles
    gl.uniform4f(colorLoc, 1.0, 1.0, 1.0, 1.0);
    gl.uniform1f(pointSizeLoc, 1.0);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttrib2f(positionLoc, 0, 0);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, particleCount);

    gl.disableVertexAttribArray(positionLoc);

    // 2. Draw Gravity Points (if visible)
    if (showGravityPoints && gravityObjects.length > 0) {
        gl.disableVertexAttribArray(positionLoc);
        gl.uniform1f(pointSizeLoc, 6.0); // Bigger dots

        for (const obj of gravityObjects) {
            let r, g, b;

            if (obj.type === 'repulse') {
                // Blue
                if (isGravityActive) { r = 0.0; g = 0.5; b = 1.0; } // Active Blue
                else { r = 0.0; g = 0.2; b = 0.4; } // Dark Blue
            } else {
                // Red (Attract)
                if (isGravityActive) { r = 1.0; g = 0.0; b = 0.0; } // Active Red
                else { r = 0.3; g = 0.0; b = 0.0; } // Dark Red
            }

            gl.uniform4f(colorLoc, r, g, b, 1.0);
            gl.vertexAttrib2f(positionLoc, obj.x, obj.y);
            gl.drawArrays(gl.POINTS, 0, 1);
        }

        gl.enableVertexAttribArray(positionLoc);
    }

    // 3. Draw Counter Circle (if active)
    if (isCounterActive) {
        // Draw green circle loop
        const segments = 40;
        const circleVertices = [];
        for (let i = 0; i < segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            circleVertices.push(
                mousePos.x + counterRadius * Math.cos(theta),
                mousePos.y + counterRadius * Math.sin(theta)
            );
        }

        // Use a temporary buffer for the circle
        const circleBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, circleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(circleVertices), gl.STREAM_DRAW);

        gl.uniform4f(colorLoc, 0.0, 1.0, 0.0, 0.5); // Green transparency
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINE_LOOP, 0, segments);

        gl.disableVertexAttribArray(positionLoc);
        gl.deleteBuffer(circleBuffer);
    }
}

function countParticles() {
    if (!isCounterActive) return;

    let count = 0;
    const r2 = counterRadius * counterRadius;

    // Loop through particles (CPU bound - might be slow for 500k)
    // Optimization: check bounding box first? 
    // For now simple dist check.
    for (let i = 0; i < particleCount; i++) {
        const px = particles[i * 2];
        const py = particles[i * 2 + 1];

        const dx = px - mousePos.x;
        const dy = py - mousePos.y;

        if (Math.abs(dx) > counterRadius || Math.abs(dy) > counterRadius) continue; // Bounding box check

        if (dx * dx + dy * dy <= r2) {
            count++;
        }
    }
    particlesInRadius = count;
    particleCountDisplay.textContent = count;
}

function gameLoop(timestamp) {
    if (!isRunning && !isCounterActive) return; // If paused and counter off, stop loop
    // BUT if counter IS active, we need loop to update count even if paused? 
    // Actually if paused, particles don't move, so count only updates on mouse move.
    // So main loop can respect isRunning. 
    // Exception: if we want to see the circle move while paused.

    if (isRunning) {
        if (timestamp - lastUpdateTime >= updateInterval) {
            updateParticles();
            lastUpdateTime = timestamp;
            if (isCounterActive) countParticles(); // Count every update tick
        }
    } else if (isCounterActive) {
        // Draw only (for circle)
        // Count only on mouse move (optimized elsewhere) or here?
        // Let's just render.
    }

    render();
    if (isRunning || isCounterActive) {
        animationId = requestAnimationFrame(gameLoop);
    }
}

// ... event listeners ...

// Update mouse pos for counter
canvas.addEventListener('mousemove', (e) => {
    if (isCounterActive) {
        mousePos = getMousePos(e);
        if (!isRunning) {
            countParticles(); // Manually update count if paused
            render();
        }
    }
});

// UI Controls
const counterToggle = document.getElementById('counterToggle');
const counterControls = document.getElementById('counterControls');
const counterRadiusSlider = document.getElementById('counterRadius');
const counterRadiusVal = document.getElementById('counterRadiusVal');
const particleCountDisplay = document.getElementById('particleCountDisplay');

counterToggle.addEventListener('change', (e) => {
    isCounterActive = e.target.checked;
    counterControls.style.display = isCounterActive ? 'block' : 'none';
    if (isCounterActive && !isRunning) {
        gameLoop(performance.now()); // Restart loop for visual updates
    }
});

counterRadiusSlider.addEventListener('input', (e) => {
    counterRadius = parseInt(e.target.value);
    counterRadiusVal.textContent = counterRadius;
    if (!isRunning && isCounterActive) {
        countParticles();
        render();
    }
});

// Particle Gravity UI Controls
const particleGravityToggle = document.getElementById('particleGravityToggle');
const particleRepulseToggle = document.getElementById('particleRepulseToggle');
const particleInteractionControls = document.getElementById('particleInteractionControls');
const particleGravityStrengthSlider = document.getElementById('particleGravityStrength');
const particleGravityStrengthVal = document.getElementById('particleGravityStrengthVal');

function updateParticleInteractionUI() {
    const anyActive = isParticleAttractEnabled || isParticleRepulseEnabled;
    particleInteractionControls.style.display = anyActive ? 'block' : 'none';
}

particleGravityToggle.addEventListener('change', (e) => {
    isParticleAttractEnabled = e.target.checked;
    updateParticleInteractionUI();
});

particleRepulseToggle.addEventListener('change', (e) => {
    isParticleRepulseEnabled = e.target.checked;
    updateParticleInteractionUI();
});

particleGravityStrengthSlider.addEventListener('input', (e) => {
    particleGravityStrength = parseFloat(e.target.value);
    particleGravityStrengthVal.textContent = e.target.value;
});

// Show/Hide Points Logic
let showGravityPoints = true;
const showPointsCheckbox = document.getElementById('showPointsFunc');

showPointsCheckbox.addEventListener('change', (e) => {
    showGravityPoints = e.target.checked;
    if (!isRunning) render();
});

// Interaction Logic
let isDraggingPoint = false;
let activeDragPoint = null;

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Only process left click

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const type = gravityTypeSelect.value;

    // Create new point
    const newPoint = { type, x, y };
    gravityObjects.push(newPoint);

    // Start dragging this new point
    isDraggingPoint = true;
    activeDragPoint = newPoint;

    if (!isRunning) render();
});

canvas.addEventListener('mousemove', (e) => {
    const pos = getMousePos(e);

    // 1. Update Counter Mouse Pos
    if (isCounterActive) {
        mousePos = pos;
    }

    // 2. Drag Active Point (Live Gravity)
    if (isDraggingPoint && activeDragPoint) {
        activeDragPoint.x = pos.x;
        activeDragPoint.y = pos.y;
    }

    // Re-render if paused (to show movement)
    if (!isRunning && (isCounterActive || isDraggingPoint)) {
        if (isCounterActive) countParticles();
        render();
    }
});

canvas.addEventListener('mouseup', () => {
    isDraggingPoint = false;
    activeDragPoint = null;
});

// Canvas Interaction: Right-click to delete gravity point
canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // Prevent default browser menu

    const pos = getMousePos(e);
    const hitRadius = 15; // Detection radius in canvas pixels

    // Find index of point clicked
    let indexToRemove = -1;
    for (let i = 0; i < gravityObjects.length; i++) {
        const obj = gravityObjects[i];
        const dist = Math.hypot(obj.x - pos.x, obj.y - pos.y);

        if (dist <= hitRadius) {
            indexToRemove = i;
            break; // Remove only one at a time (the top-most or first found)
        }
    }

    if (indexToRemove !== -1) {
        gravityObjects.splice(indexToRemove, 1);
        if (!isRunning) render();
    }
});

// UI Event Listeners
toggleBtn.addEventListener('click', () => {
    isRunning = !isRunning;
    if (isRunning) {
        toggleBtn.textContent = 'Duraklat';
        toggleBtn.classList.remove('paused');
        lastUpdateTime = performance.now();
        gameLoop(lastUpdateTime);
    } else {
        toggleBtn.textContent = 'Başlat';
        toggleBtn.classList.add('paused');
        cancelAnimationFrame(animationId);
    }
});

restartBtn.addEventListener('click', () => {
    initSystem();
    render();
});

const clearGravityBtn = document.getElementById('clearGravityBtn');

gravityBtn.addEventListener('click', () => {
    isGravityActive = !isGravityActive;
    if (isGravityActive) {
        gravityBtn.textContent = 'Yerçekimi: Açık';
        gravityBtn.classList.add('active');
    } else {
        gravityBtn.textContent = 'Yerçekimi: Kapalı';
        gravityBtn.classList.remove('active');
    }
    if (!isRunning) render();
});

clearGravityBtn.addEventListener('click', () => {
    gravityObjects = [];
    if (!isRunning) render();
});

particleCountSlider.addEventListener('input', (e) => {
    particleCountVal.textContent = e.target.value;
    initSystem();
    render();
});

updateSpeedSlider.addEventListener('input', (e) => {
    updateSpeedVal.textContent = e.target.value;
    updateInterval = parseInt(e.target.value);
});

gravityStrengthSlider.addEventListener('input', (e) => {
    gravityStrengthVal.textContent = e.target.value;
    gravityStrengthBase = parseFloat(e.target.value);
});

// Start
initSystem();
render();
