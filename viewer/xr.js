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

function createXRSort(session,origin,onNavigation,onError) {
    const worker=new Worker('sort-worker.js?v=6');
    const points=model.points.slice(0,model.n*4);
    worker.postMessage({points,origin},[points.buffer]);
    let buffer=new ArrayBuffer(model.n*4), spare=new ArrayBuffer(model.n*4), latest, last, pending=false, failure;
    worker.onmessage=({data})=>{
        if(data.nav) {onNavigation(readNavigation(data.nav,origin));return;}
        pending=false;
        latest=new Uint32Array(data.buffer,0,data.count);
    };
    worker.onerror=event=>{
        failure=Error(event.message||'The VR sorting worker stopped.');
        onError(failure);
    };
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
        // A default first-N cutoff changes the visible set when only the head angle changes.
        const options={detail:$('lod').checked,lod,quality:Math.round(quality*100)/100,narrow:$('sort').value==='16',
            front:!!frame.frontToBack,cap:Math.min(frame.maxSplats??model.n,model.n)};
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

function xrNeedsComposite(dual,marker) {
    return dual||!!marker||!!frame.alpha||!!frame.frontToBack||$('color').value==='2';
}

const teleportRibbonStride=6;
const teleportRibbonFloats=29*6*teleportRibbonStride;

function writeTeleportRibbon(eye,{width,height},aim,vertices) {
    const color=aim.target?[.92,.81,.44]:[1,.16,.08];
    const viewPoint=point=>{
        const relative=point.map((value,i)=>value-eye.pos[i]);
        return [dot(relative,eye.right),-dot(relative,eye.down),dot(relative,eye.f)];
    };
    const project=(p,other)=>{
        if(p[2]<eye.near) {
            const t=(eye.near-p[2])/(other[2]-p[2]);
            p=[p[0]+t*(other[0]-p[0]),p[1]+t*(other[1]-p[1]),eye.near];
        }
        return [p[0]/(p[2]*eye.tan[0])+eye.shift[0],p[1]/(p[2]*eye.tan[1])+eye.shift[1]];
    };
    let count=0;
    let start=viewPoint(aim.arc[0]);
    for(let i=1;i<aim.arc.length;i++) {
        const end=viewPoint(aim.arc[i]);
        if(start[2]>=eye.near||end[2]>=eye.near) {
            const a=project(start,end),b=project(end,start);
            const dx=(b[0]-a[0])*width,dy=(b[1]-a[1])*height;
            const length=Math.hypot(dx,dy);
            if(length>.01) {
                const wx=-dy/length*6/width,wy=dx/length*6/height;
                const corners=[[a[0]+wx,a[1]+wy],[a[0]-wx,a[1]-wy],[b[0]+wx,b[1]+wy],[b[0]-wx,b[1]-wy]];
                for(const j of [0,1,2,2,1,3]) vertices.set([...corners[j],...color,j%2?-1:1],count++*teleportRibbonStride);
            }
        }
        start=end;
    }
    return count;
}

function createGlTeleportRibbon() {
    const ribbon=program(`#version 300 es
        layout(location=0) in vec2 position;
        layout(location=1) in vec3 color;
        layout(location=2) in float edge;
        out mediump vec3 tint;
        out mediump float strokeEdge;
        void main() { tint=color; strokeEdge=edge; gl_Position=vec4(position,0.0,1.0); }`,
    `#version 300 es
        precision mediump float;
        in vec3 tint;
        in float strokeEdge;
        out vec4 result;
        void main() {
            float aa=max(fwidth(strokeEdge)*.5,.001);
            float coverage=1.0-smoothstep(.64-aa,.64+aa,abs(strokeEdge));
            result=vec4(tint*coverage,coverage);
        }`);
    const vertices=new Float32Array(teleportRibbonFloats);
    const vao=gl.createVertexArray(),buffer=gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,vertices.byteLength,gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0,2,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2,1,gl.FLOAT,false,24,20);
    return {
        draw(eye,viewport,aim) {
            if(!aim?.arc.length) return;
            const count=writeTeleportRibbon(eye,viewport,aim,vertices);
            if(!count) return;
            gl.viewport(viewport.x,viewport.y,viewport.width,viewport.height);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(ribbon.handle);
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
            gl.bufferSubData(gl.ARRAY_BUFFER,0,vertices,0,count*teleportRibbonStride);
            gl.drawArrays(gl.TRIANGLES,0,count);
        },
        destroy() {
            gl.deleteBuffer(buffer);
            gl.deleteVertexArray(vao);
            gl.deleteProgram(ribbon.handle);
        }
    };
}

async function createXRGlRenderer(session,scale) {
    if(!gl) throw Error('WebGL 2 is unavailable.');
    await gl.makeXRCompatible();
    const layer=new XRWebGLLayer(session,gl,{alpha:false,antialias:false,depth:false,framebufferScaleFactor:scale});
    session.updateRenderState({baseLayer:layer});
    const layers=[],output={},ribbon=createGlTeleportRibbon();
    return {
        label:'Immersive WebGL',
        destroy() {
            ribbon.destroy();
            for(const eye of layers) for(const part of [eye.full,eye.low]) {
                if(!part) continue;
                gl.deleteTexture(part.texture);
                gl.deleteFramebuffer(part.fb);
            }
        },
        draw(eyes,center,order,aim) {
            const target=aim?.target;
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
            const offscreen=xrNeedsComposite(dual,target);
            const measuring=beginGlTiming();
            try {
                for(const [i,eye] of eyes.entries()) {
                    const {x,y,width,height}=viewports[i];
                    if(!offscreen) {
                        drawLayer(output,eye,focal,center,viewports[i]);
                    } else {
                        const cache=layers[i] ||= {};
                        cache.full=makeLayer(cache.full,width,height);
                        if(reuse!==2||!cache.full.eye) drawLayer(cache.full,eye,focal,center);
                        if(dual) {
                            cache.low=makeLayer(cache.low,Math.max(1,width>>1),Math.max(1,height>>1));
                            if(reuse!==1||!cache.low.eye) drawLayer(cache.low,eye,[focal[0]*.5,focal[1]*.5],center);
                        }
                        compose(cache.full,dual?cache.low:null,eye,x,width,reuse,output.fb,y,height,target);
                    }
                    ribbon.draw(eye,viewports[i],aim);
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

function teleportAim(frame,space,input,basis,origin,head,nav) {
    if(!nav||nav.floor===null||!input.targetRaySpace) return null;
    const m=frame.getPose(input.targetRaySpace,space)?.transform.matrix;
    if(!m) return null;
    const hand=toWorld(m[12],m[13],m[14],basis).map((value,i)=>value+origin[i]);
    const direction=toWorld(-m[8],-m[9],-m[10],basis);
    const stabilizer=[head[0],head[1],head[2]-.25];
    const arc=[];
    const target=teleportArcLanding(nav,head,controllerTeleportArc(hand,direction,stabilizer),arc);
    return {arc,target};
}

function exitPressed(input) {
    const pad=input?.gamepad;
    if(!pad||input.handedness!=='left'||pad.mapping!=='xr-standard') return false;
    const profiles=input.profiles??[];
    const touch=profiles.some(profile=>/^oculus-touch($|-)|^meta-quest-touch($|-)/.test(profile));
    if(!touch) return false;
    // Touch Plus, Touch Pro and Touch v3 report Menu at index 7 when the browser exposes it.
    const hasMenu=profiles.includes('meta-quest-touch-plus')||profiles.includes('meta-quest-touch-pro')||profiles.includes('oculus-touch-v3');
    return !!((hasMenu&&pad.buttons[7]?.pressed)||pad.buttons[5]?.pressed);
}

function createLocomotion(origin,startYaw,getNavigation) {
    let yaw=startYaw, turnHeld=false, aimHeld=false, aim=null;

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
            aim=teleportAim(frame,space,left,basis,origin,from,nav);
        } else if(aimHeld) {
            const target=aim?.target;
            if(left&&!changed&&Math.abs(forward)<.25&&target&&canReachLanding(nav,from,target)) {
                origin[0]=target[0]-offset[0];
                origin[1]=target[1]-offset[1];
                origin[2]=target[2];
                changed=true;
            }
            aimHeld=false;
            aim=null;
        }
        return {basis,aim,changed};
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
            requiredFeatures:['local-floor'],
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
            $('xrAdaptive').disabled=false;
            immersiveRunning=false;
            starting=false;
            xrAvailable();
            requestRender();
        },{once:true});
        const scale=Number($('xrScale').value);
        const origin=[...pose.eye], startYaw=pose.yaw;
        const scanStart=[origin[0],origin[1],model.pivot[2]];
        let navigation,navigationError;
        const sorted=createXRSort(session,scanStart,nav=>{navigation=nav;},error=>{navigationError=error;});
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
        const space=await session.requestReferenceSpace('local-floor');
        let anchored=false;
        const move=createLocomotion(origin,startYaw,()=>navigation);
        let previousTime;
        tick=0;
        const gpuTiming=renderer.canTime??!!gpuTimer;
        $('xrAdaptive').disabled=!gpuTiming;
        xrStatus.textContent=renderer.label;
        const animate=(time,frame)=>{
            if(failed) return;
            const left=[...session.inputSources].find(input=>input.handedness==='left');
            if(exitPressed(left)) {
                session.end().catch(error=>{
                    xrStatus.textContent='Could not exit VR. '+error.message;
                    session.requestAnimationFrame(animate);
                });
                return;
            }
            session.requestAnimationFrame(animate);
            const head=frame.getViewerPose(space);
            if(!head?.views.length) return;
            if(navigationError) {
                failed=true;
                xrStatus.textContent=navigationError.message;
                session.end().catch(()=>{});
                return;
            }
            if(!navigation) return;
            if(!anchored) {
                const {x,z}=head.transform.position;
                const offset=toWorld(x,0,z,worldBasis(startYaw));
                const [spawnX,spawnY]=navigationSpawn(navigation);
                origin[0]=spawnX-offset[0];
                origin[1]=spawnY-offset[1];
                origin[2]=navigation.floor??(scanStart[2]-1.6);
                if(navigation.floor===null) xrStatus.textContent='Scan floor not found. Teleport is unavailable.';
                anchored=true;
            }
            const elapsed=time-(previousTime??time);
            if(elapsed>0&&elapsed<250) {
                totalTime+=elapsed;
                frames++;
            }
            previousTime=time;
            const {basis,aim,changed}=move(frame,space,head,session.inputSources);
            if(changed) tick=0;
            const eyes=[...head.views].map(view=>xrEye(view,origin,basis));
            const center=eyes[0].pos.map((v,i)=>(v+eyes.at(-1).pos[i])*.5);
            try {renderer.draw(eyes,center,sorted(eyes,center,time),aim);}
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
