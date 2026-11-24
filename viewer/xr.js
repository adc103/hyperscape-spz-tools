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

function createXRSort(session,cap,origin,onNavigation) {
    const worker=new Worker('sort-worker.js');
    const points=model.points.slice(0,model.n*4);
    worker.postMessage({points,origin},[points.buffer]);
    let buffer=new ArrayBuffer(model.n*4), spare=new ArrayBuffer(model.n*4), latest, last, pending=false, failure;
    worker.onmessage=({data})=>{
        if(data.nav) {onNavigation(readNavigation(data.nav,origin));return;}
        pending=false;
        latest=new Uint32Array(data.buffer,0,data.count);
    };
    worker.onerror=event=>{failure=Error(event.message||'The VR sorting worker stopped.');};
    session.addEventListener('end',()=>worker.terminate(),{once:true});
    return (eyes,center,time)=>{
        if(failure) throw failure;
        const previous=last;
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
        const stale=result&&previous&&(
            Math.hypot(center[0]-previous.center[0],center[1]-previous.center[1],center[2]-previous.center[2])>.45||
            dot(eye.f,previous.forward)<.92);
        return stale?undefined:result;
    };
}

function xrNeedsComposite(dual) {
    return dual||!!frame.alpha||!!frame.frontToBack||$('color').value==='2';
}

// Project a small ground ring so aiming can keep the direct splat render path.
const ringVertices=50;
const ringShape=Float32Array.from({length:ringVertices*2},(_,i)=>{
    const vertex=i>>1;
    const angle=(vertex>>1)*Math.PI/12;
    const radius=vertex&1?.23:.16;
    return radius*(i&1?Math.sin(angle):Math.cos(angle));
});
function projectRing(vertices,eye,marker) {
    const m=eye.xrView.projectionMatrix,{pos,right,down,f}=eye;
    const z=marker[2]+.012-pos[2];
    for(let i=0;i<ringVertices;i++) {
        const x=marker[0]+ringShape[i*2]-pos[0],y=marker[1]+ringShape[i*2+1]-pos[1];
        const a=x*right[0]+y*right[1]+z*right[2];
        const b=-(x*down[0]+y*down[1]+z*down[2]);
        const c=-(x*f[0]+y*f[1]+z*f[2]);
        const k=i*4;
        for(let j=0;j<4;j++) vertices[k+j]=m[j]*a+m[4+j]*b+m[8+j]*c+m[12+j];
    }
    return vertices;
}
function createGLRing() {
    const {handle}=program(`#version 300 es
layout(location=0) in vec4 point;
void main(){gl_Position=point;}`,`#version 300 es
precision highp float;
out vec4 color;
void main(){color=vec4(.92,.81,.44,1);}`);
    const vao=gl.createVertexArray(),buffer=gl.createBuffer(),vertices=new Float32Array(ringVertices*4);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.vertexAttribPointer(0,4,gl.FLOAT,false,0,0);
    gl.enableVertexAttribArray(0);
    return {
        draw(eye,target) {
            gl.disable(gl.BLEND);
            gl.useProgram(handle);
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
            gl.bufferData(gl.ARRAY_BUFFER,projectRing(vertices,eye,target),gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLE_STRIP,0,ringVertices);
        },
        destroy() {
            gl.deleteProgram(handle);
            gl.deleteBuffer(buffer);
            gl.deleteVertexArray(vao);
        }
    };
}

async function createXRGlRenderer(session,scale) {
    if(!gl) throw Error('WebGL 2 is unavailable.');
    await gl.makeXRCompatible();
    const layer=new XRWebGLLayer(session,gl,{alpha:false,antialias:false,depth:false,framebufferScaleFactor:scale});
    session.updateRenderState({baseLayer:layer});
    const layers=[],output={};
    const ring=createGLRing();
    return {
        label:'Immersive WebGL',
        destroy() {
            ring.destroy();
            for(const eye of layers) for(const part of [eye.full,eye.low]) {
                if(!part) continue;
                gl.deleteTexture(part.texture);
                gl.deleteFramebuffer(part.fb);
            }
        },
        draw(eyes,center,order,target) {
            if(order) {
                drawCount=order.length;
                gl.bindBuffer(gl.ARRAY_BUFFER,resources.indices);
                gl.bufferData(gl.ARRAY_BUFFER,order,gl.DYNAMIC_DRAW);
            }
            const viewports=eyes.map(eye=>layer.getViewport(eye.xrView));
            const focal=[viewports[0].width/(2*eyes[0].tan[0]),viewports[0].height/(2*eyes[0].tan[1])];
            output.fb=layer.framebuffer;
            gl.bindFramebuffer(gl.FRAMEBUFFER,output.fb);
            gl.clearColor(0,0,0,1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const {dual,reuse}=xrFramePlan();
            const offscreen=xrNeedsComposite(dual);
            const measuring=beginGlTiming();
            try {
                for(const [i,eye] of eyes.entries()) {
                    const {x,y,width,height}=viewports[i];
                    if(!offscreen) {
                        drawLayer(output,eye,focal,center,viewports[i]);
                        if(target) ring.draw(eye,target);
                        continue;
                    }
                    const cache=layers[i] ||= {};
                    cache.full=makeLayer(cache.full,width,height);
                    if(reuse!==2||!cache.full.eye) drawLayer(cache.full,eye,focal,center);
                    if(dual) {
                        cache.low=makeLayer(cache.low,Math.max(1,width>>1),Math.max(1,height>>1));
                        if(reuse!==1||!cache.low.eye) drawLayer(cache.low,eye,[focal[0]*.5,focal[1]*.5],center);
                    }
                    compose(cache.full,dual?cache.low:null,eye,x,width,reuse,output.fb,y,height,target);
                }
            } finally {
                if(measuring) gl.endQuery(gpuTimer.TIME_ELAPSED_EXT);
            }
        }
    };
}

function joystick(input) {
    const axes=input?.gamepad?.axes;
    return axes?.length>=2?[axes[axes.length-2],axes[axes.length-1]]:[0,0];
}

function teleportTarget(frame,space,input,head,basis,origin,floor) {
    const aim=input?.targetRaySpace&&frame.getPose(input.targetRaySpace,space)?.transform.matrix;
    const m=aim??head.transform.matrix;
    const direction=toWorld(-m[8],-m[9],-m[10],basis);
    const horizontal=Math.hypot(direction[0],direction[1]);
    if(horizontal<.12||direction[2]>.45) return null;
    const hand=toWorld(m[12],m[13],m[14],basis);
    const distance=direction[2]<-.12
        ?Math.max(.35,Math.min(5,(origin[2]+hand[2]-floor)*horizontal/-direction[2]))
        :2.5;
    return [origin[0]+hand[0]+direction[0]/horizontal*distance,
        origin[1]+hand[1]+direction[1]/horizontal*distance,floor];
}

function createLocomotion(origin,startYaw,getNavigation) {
    let yaw=startYaw, turnHeld=false, aimHeld=false, target=null;

    return (frame,space,head,inputs)=>{
        let changed=false;
        const left=[...inputs].find(input=>input.handedness==='left');
        const right=[...inputs].find(input=>input.handedness==='right');
        const [turn]=joystick(right), [,forward]=joystick(left);
        const {x,y,z}=head.transform.position;
        const nav=getNavigation();
        if(Math.abs(turn)<.3) turnHeld=false;
        if(!turnHeld&&Math.abs(turn)>.7) {
            turnHeld=true;
            const before=toWorld(x,y,z,worldBasis(yaw));
            yaw-=Math.sign(turn)*Math.PI/6;
            const after=toWorld(x,y,z,worldBasis(yaw));
            origin[0]+=before[0]-after[0];
            origin[1]+=before[1]-after[1];
            changed=true;
        }
        const basis=worldBasis(yaw);
        const offset=toWorld(x,y,z,basis);
        const from=offset.map((value,i)=>origin[i]+value);
        if(left&&forward<-.65) aimHeld=true;
        if(aimHeld&&left&&forward<-.25) {
            const candidate=nav&&teleportTarget(frame,space,left,head,basis,origin,nav.floor);
            target=candidate?limitTeleport(nav,from,candidate):null;
        } else if(aimHeld) {
            if(left&&Math.abs(forward)<.25&&target&&validTeleport(nav,from,target)) {
                origin[0]=target[0]-offset[0];
                origin[1]=target[1]-offset[1];
                changed=true;
            }
            aimHeld=false;
            target=null;
        }
        return {basis,target,changed};
    };
}

enter.onclick=async()=>{
    if(!model||starting||immersiveRunning) return;
    starting=true;
    xrAvailable();
    let session,renderer,failed=false,totalTime=0,frames=0;
    try {
        const wantsGpu=canGpu&&xrSource&&!webgpuFailed;
        session=await navigator.xr.requestSession('immersive-vr',{
            optionalFeatures:wantsGpu?['webgpu']:[]
        });
        immersiveRunning=true;
        const gpuMode=session.enabledFeatures?.includes('webgpu');
        session.addEventListener('end',()=>{
            if(renderer&&!failed&&frames>1) {
                const rate=(1000*frames/totalTime).toFixed(1);
                xrStatus.textContent=renderer.label+' · '+rate+' XR frames/s last session';
            }
            renderer?.destroy();
            immersiveRunning=false;
            starting=false;
            xrAvailable();
            requestRender();
        },{once:true});
        const scale=Number($('xrScale').value);
        const performanceMode=scale<=.50;
        const cap=performanceMode?35000:scale<=.65?65000:model.n;
        const origin=[...pose.eye];
        let navigation;
        const sorted=createXRSort(session,cap,[...origin],nav=>{navigation=nav;});
        const previewQuality=quality;
        drawCount=0;
        quality=1;
        resetXRQualityFilter();
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
        const move=createLocomotion(origin,pose.yaw,()=>navigation);
        let previousTime;
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
            if(elapsed>0&&elapsed<250) {
                totalTime+=elapsed;
                frames++;
            }
            if(!gpuTiming&&elapsed>0&&elapsed<100) updateQuality(elapsed,frameBudget);
            previousTime=time;
            const {basis,target,changed}=move(frame,space,head,session.inputSources);
            if(changed) tick=0;
            const eyes=[...head.views].map(view=>xrEye(view,origin,basis));
            const center=eyes[0].pos.map((v,i)=>(v+eyes.at(-1).pos[i])*.5);
            try {renderer.draw(eyes,center,sorted(eyes,center,time),target);}
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
