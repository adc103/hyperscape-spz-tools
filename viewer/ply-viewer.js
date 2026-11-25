import {cameraFrame, initialPose} from "./ply-camera.js";
import {decodePly} from "./ply-format.js";
import {createRenderer} from "./ply-renderer.js";

const element = id => document.getElementById(id);
const canvas = element("view");
const sorter = new Worker(new URL("./ply-sort-worker.js", import.meta.url));
const radians = Math.PI / 180;
const pressed = new Set();
let renderer;
let pose;
let generation = 0;
let model = null;
let pending = false;
let dirty = false;
let drag = null;
let requested = false;

function status(message, error = false) {
    element("status").textContent = message;
    element("status").toggleAttribute("data-error", error);
}

function schedule() {
    dirty = true;
    if (requested) return;
    requested = true;
    requestAnimationFrame(() => {
        requested = false;
        if (!model || pending || !dirty) return;
        const size = canvas.getBoundingClientRect();
        const camera = cameraFrame(pose, size.width / Math.max(1,size.height));
        const distance = element("sort").value === "distance";
        pending = true;
        dirty = false;
        sorter.postMessage({...camera, distance, frame:{generation:model.generation,camera,distance}});
    });
}

sorter.onmessage = ({data:{frame,sorted}}) => {
    if (frame.generation !== model?.generation) return;
    pending = false;
    const size = canvas.getBoundingClientRect();
    const scale = Math.min(devicePixelRatio || 1, 1.5, 1600 / Math.max(1,size.width));
    const width = Math.max(1,Math.round(size.width*scale));
    const height = Math.max(1,Math.round(size.height*scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
        renderer.draw(frame.camera, sorted);
        status(`${model.name} · ${model.count.toLocaleString()} splats · ${frame.distance ? "Distance" : "Depth"} sort`);
    } catch (error) {
        status(error.message, true);
    }
    if (dirty) schedule();
};
canvas.addEventListener("webglcontextlost", () => {
    model = null;
    pending = false;
    status("The GPU context was lost. Reload the viewer to try again.", true);
});

sorter.onerror = () => {
    pending = false;
    status("The draw-order worker stopped. Reload the viewer to try again.", true);
};

element("file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = "";
    const id = ++generation;
    status("Opening PLY…");
    try {
        const buffer = await file.arrayBuffer();
        if (id !== generation) return;
        const data = decodePly(buffer);
        renderer ??= createRenderer(canvas);
        renderer.upload(data);
        pose ??= initialPose(data.points, data.count);
        sorter.postMessage({points:data.points,count:data.count},[data.points.buffer]);
        model = {generation:id,count:data.count,name:file.name};
        pending = false;
        element("empty").hidden = true;
        schedule();
    } catch (error) {
        if (id === generation) status(error.message,true);
    }
});

element("camera").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = "";
    try {
        const value = JSON.parse(await file.text());
        const candidate = Array.isArray(value?.[0]) ? value[0] : value;
        if (!Array.isArray(candidate) || candidate.length !== 7 || !candidate.every(Number.isFinite) ||
            Math.abs(candidate[4]) >= 90 || candidate[5] < 20 || candidate[5] > 130) {
            throw new Error("Use a converter camera JSON with seven numbers per pose.");
        }
        pose = candidate;
        if (model) schedule();
        else status("Camera loaded. Open a PLY to view it.");
    } catch (error) {
        status(error.message,true);
    }
});

element("sort").addEventListener("change",schedule);
new ResizeObserver(schedule).observe(canvas);

canvas.addEventListener("pointerdown",event => {
    if (!model || drag) return;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    drag = {id:event.pointerId,x:event.clientX,y:event.clientY};
});
canvas.addEventListener("pointermove",event => {
    if (event.pointerId !== drag?.id) return;
    pose[3] -= (event.clientX-drag.x)*.24;
    pose[4] = Math.max(-89,Math.min(89,pose[4]-(event.clientY-drag.y)*.24));
    drag.x = event.clientX;
    drag.y = event.clientY;
    schedule();
});
canvas.addEventListener("lostpointercapture",() => { drag = null; });

const keys = new Set(["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE"]);
canvas.addEventListener("keydown",event => {
    if (!keys.has(event.code) || !model) return;
    event.preventDefault();
    if (!pressed.size) requestAnimationFrame(move);
    pressed.add(event.code);
});
canvas.addEventListener("keyup",event => pressed.delete(event.code));
canvas.addEventListener("blur",() => pressed.clear());

function move(time) {
    if (!pressed.size) {
        move.last = 0;
        return;
    }
    const step = Math.min(.04,(time-(move.last || time))/1000)*1.45;
    move.last = time;
    const yaw = pose[3]*radians;
    const forward = Number(pressed.has("KeyW"))-Number(pressed.has("KeyS"));
    const right = Number(pressed.has("KeyD"))-Number(pressed.has("KeyA"));
    pose[0] += step*(forward*Math.cos(yaw)+right*Math.sin(yaw));
    pose[1] += step*(forward*Math.sin(yaw)-right*Math.cos(yaw));
    pose[2] += step*(Number(pressed.has("KeyE"))-Number(pressed.has("KeyQ")));
    schedule();
    requestAnimationFrame(move);
}
