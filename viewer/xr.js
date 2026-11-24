const enter=$('enterVr'), xrStatus=$('xrStatus');
const canGpu=!!navigator.gpu&&typeof XRGPUBinding==='function';
let xrSource=null, webgpuFailed=false, xrSupported=false, starting=false;
const xrAvailable=()=>{ enter.disabled=!xrSupported||!model||starting; };

async function detectXR() {
    try {
        xrSupported=!!navigator.xr&&await navigator.xr.isSessionSupported('immersive-vr');
        xrStatus.textContent=xrSupported
            ? (canGpu?'WebGPU projection available.':'WebGL immersive projection available.')
            : 'Immersive WebXR is unavailable on this browser. The preview still works.';
    } catch(error) {
        xrStatus.textContent='WebXR check failed. '+error.message;
    }
    xrAvailable();
}

installScan=scan=>{
    xrSource=canGpu?{...scan}:null;
    queueMicrotask(xrAvailable);
};
detectXR();

function worldBasis(yaw) {
    return {
        right:[Math.sin(yaw),-Math.cos(yaw),0],
        forward:[Math.cos(yaw),Math.sin(yaw),0]
    };
}
function toWorld(x,y,z,basis) {
    return [basis.right[0]*x-basis.forward[0]*z,basis.right[1]*x-basis.forward[1]*z,y];
}
function xrEye(xrView, origin, basis) {
    const m=xrView.transform.matrix, projection=xrView.projectionMatrix;
    const right=toWorld(m[0],m[1],m[2],basis);
    const down=toWorld(-m[4],-m[5],-m[6],basis);
    const f=toWorld(-m[8],-m[9],-m[10],basis);
    const pos=toWorld(m[12],m[13],m[14],basis).map((v,i)=>v+origin[i]);
    return {
        xrView,pos,right,down,f,near:.10,far:1500,
        matrix:[right[0],down[0],f[0],right[1],down[1],f[1],right[2],down[2],f[2]],
        tan:[1/Math.abs(projection[0]),1/Math.abs(projection[5])],
        shift:[-projection[8],-projection[9]],peripheral:[-projection[8],-projection[9]]
    };
}

function createXRSort(session,cap) {
    const worker=new Worker('sort-worker.js');
    const points=model.points.slice(0,model.n*4);
    worker.postMessage({points},[points.buffer]);
    let buffer=new ArrayBuffer(model.n*4), spare=new ArrayBuffer(model.n*4), latest, last, pending=false, failure;
    worker.onmessage=({data})=>{
        pending=false;
        latest=new Uint32Array(data.buffer,0,data.count);
    };
    worker.onerror=event=>{failure=Error(event.message||'The VR sorting worker stopped.');};
    session.addEventListener('end',()=>worker.terminate(),{once:true});
    return (eyes,center,time)=>{
        if(failure) throw failure;
        const result=latest;
        if(result) {
            latest=null;
            // Return the completed CPU buffer after the renderer uploads it.
            buffer=spare;
            spare=result.buffer;
        }
        const lod=detailParameters();
        const options={detail:$('lod').checked,lod,quality:Math.round(quality*100)/100,narrow:$('sort').value==='16',
            front:!!frame.frontToBack,cap:Math.max(1,Math.floor(Math.min(cap,frame.maxSplats??model.n)*quality))};
        const signature=JSON.stringify(options);
        const eye=eyes[0];
        const moved=!last||Math.hypot(center[0]-last.center[0],center[1]-last.center[1],center[2]-last.center[2])>.035||
            dot(eye.f,last.forward)<.9986||dot(eye.right,last.right)<.9986;
        if(!pending&&(!last||(time-last.time>=24&&(moved||last.signature!==signature)))) {
            // Keep the completed result readable until this frame has uploaded it.
            const outgoing=buffer;
            const poses=eyes.map(({pos,right,down,f,tan,shift,near,far})=>({pos,right,down,f,tan,shift,near,far}));
            worker.postMessage({...options,eyes:poses,center,buffer:outgoing},[outgoing]);
            last={time,center,forward:eye.f,right:eye.right,signature};
            pending=true;
        }
        return result;
    };
}

async function createXRGlRenderer(session,scale) {
    if(!gl) throw Error('WebGL 2 is unavailable.');
    await gl.makeXRCompatible();
    const layer=new XRWebGLLayer(session,gl,{alpha:false,antialias:false,depth:false,framebufferScaleFactor:scale});
    session.updateRenderState({baseLayer:layer});
    const layers=[];
    return {
        label:'Immersive WebGL',
        destroy() {
            for(const eye of layers) for(const part of [eye.full,eye.low]) {
                if(!part) continue;
                gl.deleteTexture(part.texture);
                gl.deleteFramebuffer(part.fb);
            }
        },
        draw(eyes,center,order) {
            if(order) {
                drawCount=order.length;
                gl.bindBuffer(gl.ARRAY_BUFFER,resources.indices);
                gl.bufferData(gl.ARRAY_BUFFER,order,gl.DYNAMIC_DRAW);
            }
            const viewports=eyes.map(eye=>layer.getViewport(eye.xrView));
            const focal=[viewports[0].width/(2*eyes[0].tan[0]),viewports[0].height/(2*eyes[0].tan[1])];
            gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);
            gl.clearColor(0,0,0,1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const {dual,reuse}=xrFramePlan();
            const measuring=beginGlTiming();
            try {
                for(const [i,eye] of eyes.entries()) {
                    const {x,y,width,height}=viewports[i];
                    const cache=layers[i] ||= {};
                    cache.full=makeLayer(cache.full,width,height);
                    if(reuse!==2||!cache.full.eye) drawLayer(cache.full,eye,focal,center);
                    if(dual) {
                        cache.low=makeLayer(cache.low,Math.max(1,width>>1),Math.max(1,height>>1));
                        if(reuse!==1||!cache.low.eye) drawLayer(cache.low,eye,[focal[0]*.5,focal[1]*.5],center);
                    }
                    compose(cache.full,dual?cache.low:null,eye,x,width,reuse,layer.framebuffer,y,height);
                }
            } finally {
                if(measuring) gl.endQuery(gpuTimer.TIME_ELAPSED_EXT);
            }
        }
    };
}

function joystick(input) {
    const a=input?.gamepad?.axes;
    if(!a?.length) return [0,0];
    const dead=value=>Math.abs(value)>.18?value:0;
    return [dead(a[a.length-2]||0),dead(a[a.length-1]||0)];
}

enter.onclick=async()=>{
    if(!model||starting||immersiveRunning) return;
    starting=true;
    xrAvailable();
    let session,renderer;
    try {
        const wantsGpu=canGpu&&xrSource&&!webgpuFailed;
        session=await navigator.xr.requestSession('immersive-vr',{
            optionalFeatures:wantsGpu?['webgpu']:[]
        });
        immersiveRunning=true;
        const gpuMode=session.enabledFeatures?.includes('webgpu');
        session.addEventListener('end',()=>{
            renderer?.destroy();
            immersiveRunning=false;
            starting=false;
            xrAvailable();
            requestRender();
        },{once:true});
        const scale=Number($('xrScale').value);
        const performanceMode=scale<=.50;
        const cap=performanceMode?35000:scale<=.65?65000:model.n;
        const sorted=createXRSort(session,cap);
        const previewQuality=quality;
        drawCount=0;
        quality=1;
        session.addEventListener('end',()=>{quality=previewQuality;},{once:true});
        try {
            renderer=gpuMode?await createXRGPURenderer(session,xrSource,scale):await createXRGlRenderer(session,scale);
        } catch(error) {
            if(gpuMode) {
                webgpuFailed=true;
                throw Error('WebGPU setup failed. Select Enter VR again to use WebGL. '+error.message);
            }
            throw error;
        }
        session.updateRenderState({depthNear:.10,depthFar:1500});
        const space=await session.requestReferenceSpace('local');
        const origin=[...pose.eye];
        let yaw=pose.yaw,previousTime,failed=false,average=0,samples=0;
        tick=0;
        const gpuTiming=renderer.canTime??!!gpuTimer;
        const frameBudget=session.frameRate?1000/session.frameRate:1000/72;
        xrStatus.textContent=renderer.label;
        const animate=(time,frame)=>{
            if(failed) return;
            session.requestAnimationFrame(animate);
            const head=frame.getViewerPose(space);
            if(!head?.views.length) return;
            const elapsed=time-(previousTime??time);
            const dt=Math.min(.05,elapsed/1000);
            if(!gpuTiming&&adaptiveEnabled()&&elapsed>0&&elapsed<100) {
                average=average?average*.9+elapsed*.1:elapsed;
                if(++samples%12===0) updateQuality(average,frameBudget);
            }
            previousTime=time;
            const inputs=[...session.inputSources];
            const [strafe,back]=joystick(inputs.find(input=>input.handedness==='left'));
            const [turn]=joystick(inputs.find(input=>input.handedness==='right'));
            yaw-=turn*dt*1.8;
            const basis=worldBasis(yaw);
            const delta=toWorld(strafe*dt*1.35,0,back*dt*1.35,basis);
            for(let i=0;i<3;i++) origin[i]+=delta[i];
            const eyes=[...head.views].map(view=>xrEye(view,origin,basis));
            const center=eyes[0].pos.map((v,i)=>(v+eyes.at(-1).pos[i])*.5);
            try {renderer.draw(eyes,center,sorted(eyes,center,time));}
            catch(error) {
                failed=true;
                if(gpuMode) webgpuFailed=true;
                xrStatus.textContent='VR rendering stopped. '+error.message;
                session.end().catch(()=>{});
            }
        };
        session.requestAnimationFrame(animate);
    } catch(error) {
        xrStatus.textContent=error.message;
        if(session) await session.end().catch(()=>{});
        immersiveRunning=false;
        starting=false;
        xrAvailable();
    }
};
