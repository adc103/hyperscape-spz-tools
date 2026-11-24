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

async function createXRGlRenderer(session,scale) {
    if(!gl) throw Error('WebGL 2 is unavailable.');
    await gl.makeXRCompatible();
    const layer=new XRWebGLLayer(session,gl,{alpha:false,antialias:false,depth:false,framebufferScaleFactor:scale});
    session.updateRenderState({baseLayer:layer});
    const layers=[];
    return {
        label:'Immersive WebGL',
        destroy() {
            for(const part of layers) {
                gl.deleteTexture(part.texture);
                gl.deleteFramebuffer(part.fb);
            }
        },
        draw(eyes,center) {
            if(activeQuery&&gl.getQueryParameter(activeQuery,gl.QUERY_RESULT_AVAILABLE)) {
                if(!gl.getParameter(gpuTimer.GPU_DISJOINT_EXT)) {
                    lastMs=gl.getQueryParameter(activeQuery,gl.QUERY_RESULT)/1e6;
                    if(lastMs>0) {
                        const change=Math.max(-.1,Math.min(.1,.2*((frame.gpuBudgetMs??11)/lastMs-1)));
                        quality=Math.max(.15,Math.min(1,quality*(1+change)));
                    }
                }
                gl.deleteQuery(activeQuery);
                activeQuery=null;
            }
            let measuring=false;
            if(gpuTimer&&!activeQuery) {
                activeQuery=gl.createQuery();
                gl.beginQuery(gpuTimer.TIME_ELAPSED_EXT,activeQuery);
                measuring=true;
            }
            sortVisible(eyes,center);
            const viewports=eyes.map(eye=>layer.getViewport(eye.xrView));
            const focal=[viewports[0].width/(2*eyes[0].tan[0]),viewports[0].height/(2*eyes[0].tan[1])];
            gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);
            gl.clearColor(0,0,0,1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            for(const [i,eye] of eyes.entries()) {
                const {x,y,width,height}=viewports[i];
                layers[i]=makeLayer(layers[i],width,height);
                drawLayer(layers[i],eye,focal,center);
                compose(layers[i],null,eye,x,width,0,layer.framebuffer,y,height);
            }
            if(measuring) gl.endQuery(gpuTimer.TIME_ELAPSED_EXT);
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
        vrMode=true;
        quality=Math.min(quality,.6);
        const gpuMode=session.enabledFeatures?.includes('webgpu');
        session.addEventListener('end',()=>{
            renderer?.destroy();
            immersiveRunning=false;
            vrMode=false;
            quality=1;
            starting=false;
            xrAvailable();
            requestRender();
        },{once:true});
        const scale=Number($('xrScale').value);
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
        let yaw=pose.yaw,previousTime,failed=false;
        xrStatus.textContent=renderer.label;
        const animate=(time,frame)=>{
            if(failed) return;
            session.requestAnimationFrame(animate);
            const head=frame.getViewerPose(space);
            if(!head?.views.length) return;
            const dt=Math.min(.05,(time-(previousTime??time))/1000);
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
            try {renderer.draw(eyes,center);}
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
        vrMode=false;
        quality=1;
        starting=false;
        xrAvailable();
    }
};
