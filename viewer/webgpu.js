const rayQuadraticWGSL = `
struct Camera {
    projection: mat4x4f,
    eye: vec4f,
    right: vec4f,
    down: vec4f,
    forward: vec4f,
    setup: vec4f,
    modes: vec4u,
    peripheral: vec4f,
    lod: vec4f,
    detailEye: vec4f,
}
struct Splat {
    point: vec4f,
    scale: vec4f,
    rotation: vec4f,
    dc: vec4f,
}
struct Vertex {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) color: vec4f,
    @location(2) @interpolate(flat) centerLength: f32,
}
@group(0) @binding(0) var<uniform> view: Camera;
@group(0) @binding(1) var<storage, read> splats: array<Splat>;
@group(0) @binding(2) var<storage, read> sh: array<vec2u>;
@group(0) @binding(3) var<storage, read> sorted: array<u32>;

fn rotate(q: vec4f, p: vec3f) -> vec3f {
    return p+2.0*cross(q.xyz,cross(q.xyz,p)+q.w*p);
}
fn camera(v: vec3f) -> vec3f {
    return vec3f(dot(view.right.xyz,v),dot(view.down.xyz,v),dot(view.forward.xyz,v));
}
fn half2(v: vec2f) -> vec2f { return unpack2x16float(pack2x16float(v)); }
fn half3(v: vec3f) -> vec3f { return vec3f(half2(v.xy),half2(vec2f(v.z,0)).x); }

@vertex fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Vertex {
    let rejected=Vertex(vec4f(2,2,2,1),vec2f(0),vec4f(0),1);
    let index=sorted[instance];
    let splat=splats[index];
    let dir=splat.point.xyz-view.eye.xyz;
    let center=camera(dir);
    if center.z<=0.0 { return rejected; }
    let q=splat.rotation;
    let p=rotate(vec4f(-q.xyz,q.w),dir);
    let scale=splat.scale.xyz;
    var factor=1.0;
    if view.peripheral.x>0.0 && view.peripheral.y>0.0 {
        let clip=view.projection*vec4f(center.x,-center.y,-center.z,1);
        let r=length(clip.xy/clip.w-view.peripheral.zw)*.5;
        factor+=smoothstep(view.peripheral.x*(1.0-view.peripheral.y*.01),view.peripheral.x,r);
    }
    let bias=select(0.0,0.1*dot(p,p)*factor*factor/abs(view.setup.x*view.setup.y),view.modes.z!=0u);
    let filtered=sqrt(scale*scale+vec3f(bias));
    let white=p/filtered;
    let c=length(white);
    if c<=0.00001 { return rejected; }
    var opacity=splat.point.w;
    if view.modes.z!=0u {
        opacity*=length(p*scale.yzx*scale.zxy)/(filtered.x*filtered.y*filtered.z*c);
    }
    opacity=half2(vec2f(opacity,0)).x;
    let c16=half2(vec2f(min(c,65504.0),0)).x;
    if opacity<0.0625 { return rejected; }
    let k=9.0-9.0/(255.0*opacity);
    if k<=0.0 || c16*c16<=k { return rejected; }
    let extent=sqrt(k*c16*c16/(c16*c16-k));
    if opacity<0.20 { opacity*=1.0-clamp((center.z-5.0)/4.0,0.0,1.0); }
    if view.setup.z>0.0 {
        let distance=length(splat.point.xyz-view.detailEye.xyz);
        let t=clamp((distance-view.lod.x)/(view.lod.y-view.lod.x),0.0,1.0);
        let fraction=mix(view.lod.z,view.lod.w,t)*view.detailEye.w;
        opacity*=clamp((fraction-f32(index)/view.setup.w)/view.setup.z,0.0,1.0);
    }
    if opacity<0.0625 { return rejected; }

    let normal=white/c;
    let signZ=select(-1.0,1.0,normal.z>0.0);
    let v=normal+vec3f(0,0,signZ);
    let u=camera(rotate(q,filtered*(2.0*v*v.x/dot(v,v)-vec3f(1,0,0))*signZ));
    let w=camera(rotate(q,filtered*(2.0*v*v.y/dot(v,v)-vec3f(0,1,0))));
    let a=dot(u,u);
    let b=dot(u,w);
    let d=dot(w,w);
    var angle=0.0;
    if abs(a-d)+abs(b)>1e-16 { angle=0.5*atan2(2.0*b,a-d); }
    let qa=half3(u*cos(angle)+w*sin(angle));
    let qb=half3(-u*sin(angle)+w*cos(angle));
    let uv=extent*vec2f(select(-1.0,1.0,(corner&1u)!=0u),select(-1.0,1.0,(corner&2u)!=0u));
    let pos=half3(center)+qa*uv.x+qb*uv.y;

    let n=normalize(dir);
    let x=n.x; let y=n.y; let z=n.z;
    let xx=x*x; let yy=y*y; let zz=z*z;
    let basis=array<f32,15>(
        -0.4886025119*y,0.4886025119*z,-0.4886025119*x,
        1.0925484306*x*y,-1.0925484306*y*z,0.3153915653*(2.0*zz-xx-yy),
        -1.0925484306*x*z,0.5462742153*(xx-yy),
        -0.5900435899*y*(3.0*xx-yy),2.8906114426*x*y*z,
        -0.4570457995*y*(4.0*zz-xx-yy),0.3731763326*z*(2.0*zz-3.0*xx-3.0*yy),
        -0.4570457995*x*(4.0*zz-xx-yy),1.4453057213*z*(xx-yy),
        -0.5900435899*x*(xx-3.0*yy));
    var col=splat.dc.xyz*0.2820948064+0.5;
    var detail=f32(view.modes.y);
    if (view.modes.w&1u)!=0u {
        detail*=1.0-smoothstep(0.5,1.0,length(center.xy/center.z));
    }
    for(var i=0u; i<15u; i++) {
        let band=select(select(2.0,1.0,i<8u),0.0,i<3u);
        let weight=clamp(detail-band,0.0,1.0);
        if weight<=0.0 { break; }
        let packed=sh[i*view.modes.x+index];
        var coefficient=vec3f(unpack2x16float(packed.x),unpack2x16float(packed.y).x);
        if (view.modes.w&2u)!=0u {
            coefficient=(clamp(floor(128.0*coefficient+128.5),vec3f(0),vec3f(255))-128.0)/128.0;
        }
        col+=coefficient*(basis[i]*weight);
    }
    col=max(col,vec3f(0));
    if (view.modes.w&4u)!=0u { col=pow(col,vec3f(2.2)); }
    return Vertex(view.projection*vec4f(pos.x,-pos.y,-pos.z,1),uv,vec4f(half3(col),opacity),c16);
}

@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
    let r2=dot(v.uv,v.uv);
    let d=r2/(1.0+r2/(v.centerLength*v.centerLength));
    let alpha=v.color.a*(1.0-d/9.0);
    if alpha<1.0/255.0 { discard; }
    return vec4f(v.color.rgb*alpha,alpha);
}
`;

const xrCompositeWGSL = `
struct View {
    eye: vec4f,
    right: vec4f,
    down: vec4f,
    forward: vec4f,
    previousEye: vec4f,
    previousRight: vec4f,
    previousDown: vec4f,
    previousForward: vec4f,
    lens: vec4f,
    previousLens: vec4f,
    center: vec4f,
    alpha: vec4f,
    flags: vec4f,
}
struct ScreenVertex {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}
@group(0) @binding(0) var<uniform> settings: View;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var sharp: texture_2d<f32>;
@group(0) @binding(3) var soft: texture_2d<f32>;

@vertex fn screen(@builtin(vertex_index) id: u32) -> ScreenVertex {
    let uv=vec2f(f32((id<<1u)&2u),f32(id&2u));
    return ScreenVertex(vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,0,1),uv);
}
fn previousUV(uv: vec2f) -> vec2f {
    let ndc=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0);
    let ray=(ndc-settings.lens.zw)*settings.lens.xy;
    let world=settings.eye.xyz+settings.center.z*(settings.right.xyz*ray.x-settings.down.xyz*ray.y+settings.forward.xyz);
    let delta=world-settings.previousEye.xyz;
    let depth=dot(delta,settings.previousForward.xyz);
    if depth<=0.0 { return uv; }
    let old=(vec2f(dot(delta,settings.previousRight.xyz),-dot(delta,settings.previousDown.xyz))/depth/settings.previousLens.xy)+settings.previousLens.zw;
    let sampled=vec2f(old.x*.5+.5,.5-old.y*.5);
    if any(sampled<vec2f(0)) || any(sampled>vec2f(1)) { return uv; }
    return sampled;
}
@fragment fn composite(v: ScreenVertex) -> @location(0) vec4f {
    let old=previousUV(v.uv);
    var color=textureSampleLevel(sharp,filtering,select(v.uv,old,settings.flags.x==2.0),0.0);
    if settings.flags.y!=0.0 {
        let low=textureSampleLevel(soft,filtering,select(v.uv,old,settings.flags.x==1.0),0.0);
        let ndc=vec2f(v.uv.x*2.0-1.0,1.0-v.uv.y*2.0);
        let radius=length((ndc-settings.center.xy)*settings.lens.xy);
        color=mix(color,low,smoothstep(.45,.85,radius));
    }
    if settings.flags.w!=0.0 && color.a>0.0 {
        var a=pow(color.a,settings.alpha.x);
        if a>settings.alpha.y { a=clamp(settings.alpha.z*a-settings.alpha.w,0.0,1.0); }
        color=vec4f(color.rgb*(a/color.a),a);
    }
    if color.a<settings.center.w { color=vec4f(0); }
    var rgb=color.rgb;
    if settings.flags.z!=0.0 { rgb=pow(max(rgb,vec3f(0)),vec3f(2.2)); }
    if (settings.flags.w==2.0 || settings.flags.w==3.0) && color.a>0.0 { rgb/=color.a; }
    return vec4f(rgb,1);
}
`;

function packGPUCoefficients(values) {
    if(typeof Float16Array==='function') return new Uint32Array(Float16Array.from(values).buffer);
    // SH coefficients are bounded. Convert the float32 mantissa to round-to-even FP16.
    const raw=new Uint32Array(values.buffer,values.byteOffset,values.length);
    const packed=new Uint16Array(raw.length);
    for(let i=0;i<raw.length;i++) {
        const word=raw[i], sign=(word>>>16)&0x8000;
        const exponent=((word>>>23)&255)-112;
        const mantissa=word&0x7fffff;
        if(exponent>0) {
            packed[i]=sign|((exponent<<10)+((mantissa+0xfff+((mantissa>>>13)&1))>>>13));
        } else if(exponent>=-10) {
            const shift=14-exponent, full=mantissa|0x800000;
            packed[i]=sign|((full+(1<<(shift-1))-1+((full>>>shift)&1))>>>shift);
        } else {
            packed[i]=sign;
        }
    }
    return new Uint32Array(packed.buffer);
}

async function createXRGPURenderer(session,src,scale) {
    const adapter=await navigator.gpu.requestAdapter({xrCompatible:true});
    if(!adapter) throw Error('No WebXR-compatible WebGPU adapter.');
    const canTime=adapter.features.has('timestamp-query');
    const device=await adapter.requestDevice({requiredFeatures:canTime?['timestamp-query']:[]});
    try {
        const shader=device.createShaderModule({code:rayQuadraticWGSL});
        const compilation=await shader.getCompilationInfo();
        const errors=compilation.messages.filter(message=>message.type==='error');
        if(errors.length) throw Error(errors.map(error=>error.message).join(' '));
        const binding=new XRGPUBinding(session,device);
        const format=binding.getPreferredColorFormat();
        const layer=binding.createProjectionLayer({colorFormat:format,scaleFactor:scale});
        const pipelines=await Promise.all([false,true].map(front=>{
            const blend=front?{srcFactor:'one-minus-dst-alpha',dstFactor:'one'}:{srcFactor:'one',dstFactor:'one-minus-src-alpha'};
            return device.createRenderPipelineAsync({
                layout:'auto',vertex:{module:shader,entryPoint:'vertex'},
                fragment:{module:shader,entryPoint:'fragment',targets:[{format:'rgba8unorm',blend:{color:blend,alpha:blend}}]},
                primitive:{topology:'triangle-strip'}
            });
        }));
        const compositeShader=device.createShaderModule({code:xrCompositeWGSL});
        const composite=await device.createRenderPipelineAsync({
            layout:'auto',vertex:{module:compositeShader,entryPoint:'screen'},
            fragment:{module:compositeShader,entryPoint:'composite',targets:[{format}]}
        });
        const sampler=device.createSampler({magFilter:'linear',minFilter:'linear'});
        const data=new Float32Array(src.n*16);
        for(let i=0;i<src.n;i++) {
            for(const [j,attribute] of ['points','scales','rotations','dc'].entries()) {
                const a=src[attribute], k=i*4, to=i*16+j*4;
                data[to]=a[k];data[to+1]=a[k+1];data[to+2]=a[k+2];data[to+3]=a[k+3];
            }
        }
        const buffer=(size,usage,initial)=>{
            const result=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});
            if(initial) device.queue.writeBuffer(result,0,initial);
            return result;
        };
        const splats=buffer(data.byteLength,GPUBufferUsage.STORAGE,data);
        const packedSH=packGPUCoefficients(src.sh);
        const coefficients=buffer(packedSH.byteLength,GPUBufferUsage.STORAGE,packedSH);
        const indices=buffer(src.n*4,GPUBufferUsage.STORAGE);
        const cache=[];
        const timer=canTime?{
            queries:device.createQuerySet({type:'timestamp',count:2}),
            resolved:device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),
            readback:device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),
            pending:false
        }:null;
        const packed=new Float32Array(52),mode=new Uint32Array(packed.buffer,36*4,4);
        const screen=new Float32Array(52);
        function makeTarget(old,width,height) {
            if(old?.width===width&&old.height===height) return old;
            old?.texture.destroy();
            const texture=device.createTexture({size:[width,height],format:'rgba8unorm',
                usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
            return {width,height,texture,view:texture.createView(),uniform:old?.uniform??buffer(208,GPUBufferUsage.UNIFORM)};
        }
        function renderTarget(encoder,target,eye,focal,center,front,timestampWrites) {
            target.eye=eye;
            packed.set(eye.xrView.projectionMatrix,0);
            packed.set(eye.pos,16);packed.set(eye.right,20);
            packed.set(eye.down,24);packed.set(eye.f,28);
            const lod=detailParameters();
            packed.set([...focal,$('lod').checked?(frame.detailFade??0):0,model.n],32);
            packed.set([frame.foveationRadius??0,frame.mipFadePercent??0,...eye.peripheral],40);
            packed.set([lod.start,lod.end,lod.near,lod.far],44);
            packed.set([...center,quality],48);
            mode.set([src.width*src.height,src.degree,Number($('mip').checked),
                Number($('sh').checked)|Number($('quant').checked)*2|Number($('color').value==='1')*4]);
            device.queue.writeBuffer(target.uniform,0,packed);
            const pipeline=pipelines[Number(front)];
            const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),
                entries:[target.uniform,splats,coefficients,indices].map((buffer,binding)=>({binding,resource:{buffer}}))});
            const pass=encoder.beginRenderPass({timestampWrites,colorAttachments:[{
                view:target.view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]
            }]});
            pass.setPipeline(pipeline);
            pass.setBindGroup(0,bind);
            pass.draw(4,drawCount);
            pass.end();
        }
        function composeEye(encoder,entry,eye,low,reuse,image,loadOp,timestampWrites) {
            const previous=(reuse===1?low:entry.full)?.eye??eye;
            for(const [i,v] of [eye,previous].entries()) {
                const offset=i*16;
                screen.set(v.pos,offset);screen.set(v.right,offset+4);
                screen.set(v.down,offset+8);screen.set(v.f,offset+12);
                screen.set([...v.tan,...v.shift],32+i*4);
            }
            const alpha=frame.alpha;
            const clip=eye.far*eye.near/(eye.far-(frame.clipDepth??.99)*(eye.far-eye.near));
            screen.set([...eye.peripheral,clip,alpha?.cutoff??0],40);
            screen.set([alpha?.power??1,alpha?.threshold??1,alpha?.boost??1,alpha?.offset??0],44);
            screen.set([reuse,Number(!!low),Number($('color').value==='2'),alpha?(alpha.unpremultiply?3:1):0],48);
            device.queue.writeBuffer(entry.uniform,0,screen);
            const bind=device.createBindGroup({layout:composite.getBindGroupLayout(0),entries:[
                {binding:0,resource:{buffer:entry.uniform}},{binding:1,resource:sampler},
                {binding:2,resource:entry.full.view},{binding:3,resource:(low??entry.full).view}
            ]});
            const {x,y,width,height}=image.viewport;
            const pass=encoder.beginRenderPass({timestampWrites,colorAttachments:[{
                view:image.colorTexture.createView(image.getViewDescriptor()),loadOp,storeOp:'store',clearValue:[0,0,0,1]
            }]});
            pass.setViewport(x,y,width,height,0,1);
            pass.setPipeline(composite);
            pass.setBindGroup(0,bind);
            pass.draw(3);
            pass.end();
        }
        session.updateRenderState({layers:[layer]});
        return {
            label:'Immersive WebGPU',canTime,
            destroy:()=>device.destroy(),
            draw(eyes,center,order) {
                if(order) {
                    drawCount=order.length;
                    if(drawCount) device.queue.writeBuffer(indices,0,order);
                }
                const encoder=device.createCommandEncoder();
                const images=eyes.map(eye=>binding.getViewSubImage(layer,eye.xrView));
                const left=images[0].viewport;
                const focal=[left.width/(2*eyes[0].tan[0]),left.height/(2*eyes[0].tan[1])];
                const {dual,reuse}=xrFramePlan();
                const measure=timer&&!timer.pending&&adaptiveEnabled();
                let first=!!measure;
                const stamp=()=>{
                    if(!first) return undefined;
                    first=false;
                    return {querySet:timer.queries,beginningOfPassWriteIndex:0};
                };
                for(const [i,eye] of eyes.entries()) {
                    const image=images[i],{width,height}=image.viewport;
                    const entry=cache[i] ||= {uniform:buffer(208,GPUBufferUsage.UNIFORM)};
                    const front=!!frame.frontToBack;
                    entry.full=makeTarget(entry.full,width,height);
                    if(reuse!==2||!entry.full.eye) renderTarget(encoder,entry.full,eye,focal,center,front,stamp());
                    if(dual) {
                        entry.low=makeTarget(entry.low,Math.max(1,width>>1),Math.max(1,height>>1));
                        if(reuse!==1||!entry.low.eye)
                            renderTarget(encoder,entry.low,eye,[focal[0]*.5,focal[1]*.5],center,front,stamp());
                    }
                    const shared=i>0&&images[0].colorTexture===image.colorTexture&&
                        images[0].getViewDescriptor().baseArrayLayer===image.getViewDescriptor().baseArrayLayer;
                    const end=measure&&i===eyes.length-1?{querySet:timer.queries,endOfPassWriteIndex:1}:undefined;
                    composeEye(encoder,entry,eye,dual?entry.low:null,reuse,image,shared?'load':'clear',end);
                }
                if(measure) {
                    encoder.resolveQuerySet(timer.queries,0,2,timer.resolved,0);
                    encoder.copyBufferToBuffer(timer.resolved,0,timer.readback,0,16);
                    timer.pending=true;
                }
                device.queue.submit([encoder.finish()]);
                if(measure) timer.readback.mapAsync(GPUMapMode.READ).then(()=>{
                    const [start,end]=new BigUint64Array(timer.readback.getMappedRange());
                    timer.readback.unmap();
                    if(immersiveRunning&&end>start) updateQuality(Number(end-start)/1e6);
                }).catch(()=>{}).finally(()=>{timer.pending=false;});
            }
        };
    } catch(error) {
        device.destroy();
        throw error;
    }
}
