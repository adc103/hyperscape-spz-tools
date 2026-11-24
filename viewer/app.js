const radians=v=>v*Math.PI/180;
let pose, initial, filename, renderQueued=false, generation=0;
let dragging=null;
const held=new Set();
function status(message,error=false) {
    $('status').textContent=message;
    $('status').classList.toggle('error',error);
}
function setPose(eye,yaw,pitch,fov,roll=0) {
    pose={eye:[...eye],yaw:radians(yaw),pitch:radians(pitch),fov:radians(fov),roll:radians(roll)};
    tick=0;
    requestRender();
}
let immersiveRunning=false;
let installScan=()=>{};
function requestRender() {
    if(!model||renderQueued||immersiveRunning) return;
    renderQueued=true;
    requestAnimationFrame(()=>{
        renderQueued=false;
        if(immersiveRunning) return;
        try {
            const reused=renderFrame();
            if(reused||($('adaptive').checked&&activeQuery)) requestRender();
        } catch(error) {status(error.message,true);}
    });
}
async function openScan(file) {
    if(!file) return;
    const current=++generation;
    status('Decoding '+file.name+'…');
    try {
        initialize();
        const scan=await decodeSpz(file);
        if(current!==generation) return;
        installScan(scan);
        upload(scan);
        model=scan;
        filename=file.name;
        quality=1;
        lastMs=0;
        initial=[scan.pivot,135,-4,85];
        status(file.name);
        $('empty').hidden=true;
        $('stats').hidden=false;
        setPose(...initial);
    } catch(error) {
        if(current===generation) status(error.message,true);
    }
}
$('open').onclick=()=>$('file').click();
$('file').onchange=event=>{openScan(event.target.files[0]);event.target.value='';};
$('reset').onclick=()=>{if(model) setPose(...initial);};
for(const control of document.querySelectorAll('input[type=checkbox],select')){
    control.addEventListener('change',()=>{
        tick=0;
        if(control.id==='adaptive'&&!control.checked) quality=1;
        if(control.id==='reuse'&&control.value!=='0') $('foveation').checked=true;
        requestRender();
    });
}
const viewport=$('viewport');
viewport.addEventListener('dragover',event=>event.preventDefault());
viewport.addEventListener('drop',event=>{
    event.preventDefault();
    const files=[...event.dataTransfer.files];
    const spz=files.find(file=>/\.spz$/i.test(file.name));
    if(spz) openScan(spz);
    else status('Choose a Hyperscape SPZ file.',true);
});
canvas.addEventListener('pointerdown',e=>{
    if(!model || frame.eyes || e.button!==0 || dragging) return;
    dragging=[e.clientX,e.clientY,e.pointerId];
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',e=>{
    if(!dragging||dragging[2]!==e.pointerId) return;
    pose.yaw-=(e.clientX-dragging[0])*.003;
    pose.pitch=Math.min(1.55,Math.max(-1.55,pose.pitch-(e.clientY-dragging[1])*.003));
    dragging=[e.clientX,e.clientY,e.pointerId];
    requestRender();
});
for(const event of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(event,e=>{
    if(dragging?.[2]===e.pointerId) dragging=null;
});
canvas.addEventListener('wheel',e=>{
    if(!model||frame.eyes) return;
    e.preventDefault();
    const f=cameraEyes(1,1)[0].f;
    const step=Math.max(-.6,Math.min(.6,-e.deltaY*.003));
    pose.eye=pose.eye.map((v,i)=>v+f[i]*step);
    requestRender();
},{passive:false});
let prevTime=0;
function navigate(now) {
    if(!held.size || !model) {prevTime=0;return;}
    const step=prevTime?Math.min(.05,(now-prevTime)/1000)*1.5:0;
    prevTime=now;
    const f=Number(held.has('w'))-Number(held.has('s'));
    const r=Number(held.has('d'))-Number(held.has('a'));
    const z=Number(held.has('e'))-Number(held.has('q'));
    pose.eye[0]+=(Math.cos(pose.yaw)*f+Math.sin(pose.yaw)*r)*step;
    pose.eye[1]+=(Math.sin(pose.yaw)*f-Math.cos(pose.yaw)*r)*step;
    pose.eye[2]+=z*step;
    requestRender();
    requestAnimationFrame(navigate);
}
canvas.addEventListener('keydown',e=>{
    const key=e.key.toLowerCase();
    if(!model || frame.eyes || !['w','a','s','d','q','e'].includes(key)) return;
    e.preventDefault();
    const already=held.size;
    held.add(key);
    if(!already) requestAnimationFrame(navigate);
});
window.addEventListener('keyup',e=>held.delete(e.key.toLowerCase()));
window.addEventListener('blur',()=>held.clear());
canvas.addEventListener('blur',()=>held.clear());
canvas.addEventListener('webglcontextlost',event=>{
    event.preventDefault();
    model=null;resources=null;gpuModel=null;activeQuery=null;eyesHistory=[];
    status('The browser reset the GPU. Reopen the SPZ after the context recovers.',true);
});
new ResizeObserver(requestRender).observe(viewport);
