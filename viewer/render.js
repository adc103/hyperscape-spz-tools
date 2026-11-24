const $ = id => document.getElementById(id);
const canvas = $('view');
const gl = canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,xrCompatible:!!navigator.xr});
const gpuTimer = gl?.getExtension('EXT_disjoint_timer_query_webgl2');
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
let resources, model, gpuModel, eyesHistory=[], sortData;
let drawCount=0, quality=1, lastMs=0, tick=0, activeQuery=null;

function program(vertex,fragment) {
    const handle=gl.createProgram();
    for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
        const shader=gl.createShader(type);
        gl.shaderSource(shader,source);
        gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
        gl.attachShader(handle,shader);
        gl.deleteShader(shader);
    }
    gl.linkProgram(handle);
    if(!gl.getProgramParameter(handle,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(handle));
    const uniforms={};
    for(let i=0;i<gl.getProgramParameter(handle,gl.ACTIVE_UNIFORMS);++i) {
        const name=gl.getActiveUniform(handle,i).name;
        uniforms[name]=gl.getUniformLocation(handle,name);
    }
    return {handle, uniforms};
}
function tex(target, smooth=false) {
    const texture=gl.createTexture();
    gl.bindTexture(target,texture);
    gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,smooth?gl.LINEAR:gl.NEAREST);
    gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,smooth?gl.LINEAR:gl.NEAREST);
    gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return texture;
}
function initialize() {
    if(!gl) throw Error('WebGL 2 is unavailable. Open the viewer in a browser with hardware acceleration.');
    if(resources) return;
    const splat=program(splatVertex,splatFragment), screen=program(screenVertex,screenFragment);
    const vao=gl.createVertexArray(), indices=gl.createBuffer(), screenVao=gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,indices);
    gl.vertexAttribIPointer(0,1,gl.UNSIGNED_INT,4,0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribDivisor(0,1);
    resources={splat,screen,vao,indices,screenVao};
    $('adaptive').disabled=!gpuTimer;
}
function upload(scan) {
    const {width,height,terms}=scan;
    if(height>gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw Error('Scan exceeds this GPU’s texture dimensions.');
    const incoming={};
    try {
        gl.activeTexture(gl.TEXTURE0);
        for(const name of ['points','scales','rotations','dc']) {
            incoming[name]=tex(gl.TEXTURE_2D);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width,height,0,gl.RGBA,gl.FLOAT,scan[name]);
        }
        incoming.sh=tex(gl.TEXTURE_2D_ARRAY);
        gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA16F,width,height,Math.max(terms,1),0,gl.RGBA,gl.FLOAT,scan.sh);
        if(gl.getError()!==gl.NO_ERROR) throw Error('The GPU could not allocate the scan textures.');
    } catch(error) {
        Object.values(incoming).forEach(t=>gl.deleteTexture(t));
        throw error;
    }
    if(gpuModel) Object.values(gpuModel).forEach(t=>gl.deleteTexture(t));
    gpuModel=incoming;
    delete scan.sh;
    delete scan.dc;
    delete scan.rotations;
    delete scan.scales;
    sortData={ids:new Uint32Array(scan.n), keys:new Float32Array(scan.n)};
}
function cameraEyes(width,height) {
    if(frame.eyes) return frame.eyes.map(e=>{
        const {right,down,forward:f}=e;
        return {
            pos:e.position,right,down,f,tan:e.tan,shift:e.shift??[0,0],peripheral:e.fovea??e.shift??[0,0],
            matrix:[right[0],down[0],f[0],right[1],down[1],f[1],right[2],down[2],f[2]],
            near:frame.near??.1,far:frame.far??1500,depth:e.depth
        };
    });
    const yaw=pose.yaw, pitch=pose.pitch;
    const f=[Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch)];
    const r=[Math.sin(yaw),-Math.cos(yaw),0], d=cross(f,r);
    const cs=Math.cos(pose.roll), sn=Math.sin(pose.roll);
    const right=r.map((v,i)=>cs*v+sn*d[i]), down=d.map((v,i)=>cs*v-sn*r[i]);
    const matrix=[right[0],down[0],f[0],right[1],down[1],f[1],right[2],down[2],f[2]];
    const tx=Math.tan(pose.fov/2), ty=tx*height/width;
    return ($('stereo').checked?[-.032,.032]:[0]).map(offset=>({
        pos:pose.eye.map((v,i)=>v+offset*right[i]), f,right,down,matrix,tan:[tx,ty], shift:[0,0],
        near:frame.near??.1,far:frame.far??1500, peripheral:[0,0]
    }));
}
function detailParameters() {
    return {near:frame.detailNear??1, far:frame.detailFar??.60,
        start:frame.distanceNear??2, end:frame.distanceFar??6};
}
function checkView(eye,x,y,z) {
    const [rx,ry,rz]=eye.right,[dx,dy,dz]=eye.down,[fx,fy,fz]=eye.f;
    const forward=x*fx+y*fy+z*fz;
    if(forward<eye.near*.8||forward>eye.far) return false;
    const u=(x*rx+y*ry+z*rz)/eye.tan[0]/forward+eye.shift[0];
    const v=-(x*dx+y*dy+z*dz)/eye.tan[1]/forward+eye.shift[1];
    if(Math.abs(u)>1.25+.12/forward||Math.abs(v)>1.25+.12/forward) return false;
    if(eye.depth&&Math.abs(u)<1&&Math.abs(v)<1) {
        const {width,height,meters}=eye.depth;
        const depth=meters[Math.floor((1-v)*.5*height)*width+Math.floor((u+1)*.5*width)];
        if(depth>0&&forward-(frame.depthOffset??0)>depth) return false;
    }
    return true;
}
function sortVisible(eyes,center,uploadToGl=true) {
    const {points,n}=model, {ids,keys}=sortData;
    const first=eyes[0], second=eyes[1] || first;
    const detail=$('lod').checked, config=detailParameters();
    const narrow=$('sort').value==='16';
    const [ex,ey,ez]=first.pos,[sx,sy,sz]=second.pos;
    const [mx,my,mz]=center;
    const cap=frame.maxSplats??n;
    let count=0;
    for(let i=0;i<n&&count<cap;++i) {
        const j=i*4;
        if(points[j+3]<.0625) continue;
        const px=points[j],py=points[j+1],pz=points[j+2];
        const x=px-ex,y=py-ey,z=pz-ez,ax=px-sx,ay=py-sy,az=pz-sz;
        if(!checkView(first,x,y,z)&&(first===second||!checkView(second,ax,ay,az))) continue;
        const len=Math.sqrt(x*x+y*y+z*z);
        const len2=first===second?len:Math.sqrt(ax*ax+ay*ay+az*az);
        const distance=(len+len2)*.5;
        if(detail) {
            const dx=px-mx,dy=py-my,dz=pz-mz;
            const midpoint=first===second?len:Math.sqrt(dx*dx+dy*dy+dz*dz);
            const t=Math.min(1,Math.max(0,(midpoint-config.start)/(config.end-config.start)));
            const fraction=quality*(config.near+(config.far-config.near)*t);
            if(i>n*fraction) continue;
        }
        keys[i]=narrow?Math.floor((1-Math.pow(Math.min(1,Math.max(0,(distance-.1)/1499.9)),.4))*65534+.5)
            :1/(distance+1e-7);
        ids[count++]=i;
    }
    const visible=ids.subarray(0,count);
    const order=frame.frontToBack?-1:1;
    visible.sort((a,b)=>order*(keys[a]-keys[b]));
    if(uploadToGl) {
        gl.bindBuffer(gl.ARRAY_BUFFER,resources.indices);
        gl.bufferData(gl.ARRAY_BUFFER,visible,gl.DYNAMIC_DRAW);
    }
    drawCount=count;
}

function makeLayer(previous,width,height) {
    if(previous?.width===width&&previous.height===height) return previous;
    if(previous) {
        gl.deleteFramebuffer(previous.fb);
        gl.deleteTexture(previous.texture);
    }
    const texture=tex(gl.TEXTURE_2D,true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    const fb=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw Error('Could not create a render target.');
    return {texture,fb,width,height,eye:null};
}
function bindTexture(unit,target,texture,uniform) {
    gl.activeTexture(gl.TEXTURE0+unit);
    gl.bindTexture(target,texture);
    gl.uniform1i(uniform,unit);
}
function drawLayer(layer, eye, focal, detailEye, viewport) {
    gl.bindFramebuffer(gl.FRAMEBUFFER,layer.fb);
    if(viewport) {
        gl.viewport(viewport.x,viewport.y,viewport.width,viewport.height);
    } else {
        gl.viewport(0,0,layer.width,layer.height);
        gl.clearColor(0,0,0,0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.enable(gl.BLEND);
    if(frame.frontToBack) gl.blendFunc(gl.ONE_MINUS_DST_ALPHA,gl.ONE);
    else gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    const {handle,uniforms:u}=resources.splat;
    gl.useProgram(handle);
    gl.bindVertexArray(resources.vao);
    ['points','scales','rotations','dc','sh'].forEach((key,i)=>
        bindTexture(i,key==='sh'?gl.TEXTURE_2D_ARRAY:gl.TEXTURE_2D,gpuModel[key],u[key]));
    gl.uniform3fv(u.eye,eye.pos);
    gl.uniformMatrix3fv(u.camera,false,eye.matrix);
    gl.uniform2fv(u.tangent,eye.tan);
    gl.uniform2fv(u.shift,eye.shift);
    gl.uniform2fv(u.focal,focal);
    gl.uniform1f(u.nearPlane,eye.near);
    gl.uniform1f(u.farPlane,eye.far);
    gl.uniform2f(u.fadeRange,5,9);
    gl.uniform1f(u.count,model.n);
    const lod=detailParameters();
    gl.uniform1f(u.lodMultiplier,quality);
    gl.uniform1f(u.lodFade,$('lod').checked?(frame.detailFade??0):0);
    gl.uniform2f(u.lodDistances,lod.start,lod.end);
    gl.uniform2f(u.lodFractions,lod.near,lod.far);
    gl.uniform3fv(u.detailEye,detailEye);
    gl.uniform2f(u.peripheralMip,frame.foveationRadius??0,frame.mipFadePercent??0);
    gl.uniform2fv(u.peripheralCenter,eye.peripheral);
    gl.uniform1i(u.degree,model.degree);
    gl.uniform1i(u.mip,$('mip').checked);
    gl.uniform1i(u.shFoveated,$('sh').checked);
    gl.uniform1i(u.quant,$('quant').checked);
    gl.uniform1i(u.linearColor,$('color').value==='1');
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,drawCount);
    layer.eye=eye;
}
function compose(full,low,eye,x,width,reprojection,target=null,y=0,height=canvas.height,marker=null) {
    gl.bindFramebuffer(gl.FRAMEBUFFER,target);
    gl.viewport(x,y,width,height);
    gl.disable(gl.BLEND);
    const {handle,uniforms:u}=resources.screen;
    gl.useProgram(handle);
    gl.bindVertexArray(resources.screenVao);
    bindTexture(0,gl.TEXTURE_2D,full.texture,u.sharp);
    bindTexture(1,gl.TEXTURE_2D,low?.texture || full.texture,u.soft);
    gl.uniform1i(u.foveated,!!low);
    gl.uniform1i(u.compositeColor,$('color').value==='2');
    gl.uniform1i(u.reprojection,reprojection);
    const alpha=frame.alpha;
    gl.uniform1i(u.alphaEnabled,!!alpha);
    gl.uniform4f(u.alphaCurve,alpha?.power??1,alpha?.threshold??1,alpha?.boost??1,alpha?.offset??0);
    gl.uniform1i(u.unpremultiply,!!alpha?.unpremultiply);
    gl.uniform1f(u.alphaCutoff,alpha?.cutoff??0);
    const prev=(reprojection===1?low:full)?.eye || eye;
    gl.uniform3fv(u.eye,eye.pos);
    gl.uniform3fv(u.prevEye,prev.pos);
    gl.uniformMatrix3fv(u.camera,false,eye.matrix);
    gl.uniformMatrix3fv(u.prevCamera,false,prev.matrix);
    gl.uniform2fv(u.tangent,eye.tan);
    gl.uniform2fv(u.prevTangent,prev.tan);
    gl.uniform2fv(u.shift,eye.shift);
    gl.uniform2fv(u.prevShift,prev.shift);
    gl.uniform2fv(u.peripheralCenter,eye.peripheral);
    gl.uniform4f(u.teleportMarker,marker?.[0]??0,marker?.[1]??0,marker?.[2]??0,Number(!!marker));
    gl.uniform1f(u.clipDepth,eye.far*eye.near/(eye.far-(frame.clipDepth??.99)*(eye.far-eye.near)));
    gl.drawArrays(gl.TRIANGLES,0,3);
}
function adaptiveEnabled() {
    return immersiveRunning?$('xrAdaptive').checked:$('adaptive').checked;
}
function updateQuality(ms,budget=frame.gpuBudgetMs??13.8) {
    if(!adaptiveEnabled()||ms<=0) return;
    const change=Math.max(-.1,Math.min(.1,.2*(budget/ms-1)));
    quality=Math.max(.1,Math.min(1,quality*(1+change)));
}
function beginGlTiming() {
    if(activeQuery&&gl.getQueryParameter(activeQuery,gl.QUERY_RESULT_AVAILABLE)) {
        if(!gl.getParameter(gpuTimer.GPU_DISJOINT_EXT)) {
            lastMs=gl.getQueryParameter(activeQuery,gl.QUERY_RESULT)/1e6;
            updateQuality(lastMs);
        }
        gl.deleteQuery(activeQuery);
        activeQuery=null;
    }
    let measuring=false;
    if(gpuTimer&&!activeQuery&&adaptiveEnabled()) {
        activeQuery=gl.createQuery();
        gl.beginQuery(gpuTimer.TIME_ELAPSED_EXT,activeQuery);
        measuring=true;
    }
    return measuring;
}
function xrFramePlan() {
    const dual=$('foveation').checked;
    const reuse=dual&&tick++%4!==0?Number($('reuse').value):0;
    return {dual,reuse};
}
function renderFrame() {
    const view=canvas.getBoundingClientRect();
    const ratio=Math.min(window.devicePixelRatio||1,2);
    const size=[Math.max(2,Math.min(4096,Math.round(view.width*ratio))),Math.max(2,Math.min(4096,Math.round(view.height*ratio)))];
    const stereo=frame.eyes?frame.eyes.length===2:$('stereo').checked;
    if(stereo) size[0]-=size[0]%2;
    const resize=canvas.width!==size[0]||canvas.height!==size[1];
    if(resize) {canvas.width=size[0];canvas.height=size[1];tick=0;}
    const screenW=canvas.width/(stereo?2:1), screenH=canvas.height;
    const dimension=x=>Math.min(4096,Math.max(128,Math.floor(x)+(x%1===.5?Math.floor(x)%2:Math.round(x%1))));
    const w=dimension(frame.width??screenW*.9),h=dimension(frame.height??screenH*.9);
    const eyes=cameraEyes(screenW,screenH);
    if(eyesHistory.length>eyes.length) {
        for(const {full,low} of eyesHistory.splice(eyes.length)) for(const layer of [full,low]) if(layer) {
            gl.deleteFramebuffer(layer.fb);
            gl.deleteTexture(layer.texture);
        }
    }
    const dual=$('foveation').checked;
    const reuse=dual?Number($('reuse').value):0;
    const fresh=!reuse||tick%4===0||resize;
    ++tick;
    const center=eyes[0].pos.map((v,i)=>(v+eyes.at(-1).pos[i])*.5);
    sortVisible(eyes,center);
    const measuring=beginGlTiming();
    const focal=[w/(2*eyes[0].tan[0]),h/(2*eyes[0].tan[1])];
    for(let i=0;i<eyes.length;i++) {
        const cache=eyesHistory[i] ||= {};
        const eye=eyes[i];
        cache.full=makeLayer(cache.full,w,h);
        if(dual) cache.low=makeLayer(cache.low,dimension(w*.5),dimension(h*.5));
        if(fresh||reuse!==2||!cache.full.eye) drawLayer(cache.full,eye,focal,center);
        if(dual&&(fresh||reuse!==1||!cache.low.eye))
            drawLayer(cache.low,eye,[focal[0]*cache.low.width/w,focal[1]*cache.low.height/h],center);
        compose(cache.full,dual?cache.low:null,eye,i*screenW,screenW,fresh?0:reuse);
    }
    if(measuring) gl.endQuery(gpuTimer.TIME_ELAPSED_EXT);
    $('stats').textContent=`${drawCount.toLocaleString()} / ${model.n.toLocaleString()} splats · ${w} × ${h}${lastMs?' · '+lastMs.toFixed(1)+' ms GPU':''}`;
    return reuse!==0&&!fresh;
}
