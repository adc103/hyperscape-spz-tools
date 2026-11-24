const rayQuadraticWGSL = `
struct Camera {
    projection: mat4x4f,
    eye: vec4f,
    right: vec4f,
    down: vec4f,
    forward: vec4f,
    setup: vec4f,
    modes: vec4u,
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
@group(0) @binding(2) var<storage, read> sh: array<vec4f>;
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
    let bias=select(0.0,0.1*dot(p,p)/abs(view.setup.x*view.setup.y),view.modes.z!=0u);
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
        var coefficient=sh[i*view.modes.x+index].xyz;
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

async function createXRGPURenderer(session,src,scale) {
    const adapter=await navigator.gpu.requestAdapter({xrCompatible:true});
    if(!adapter) throw Error('No WebXR-compatible WebGPU adapter.');
    const device=await adapter.requestDevice();
    try {
        const shader=device.createShaderModule({code:rayQuadraticWGSL});
        const compilation=await shader.getCompilationInfo();
        const errors=compilation.messages.filter(message=>message.type==='error');
        if(errors.length) throw Error(errors.map(error=>error.message).join(' '));
        const binding=new XRGPUBinding(session,device);
        const format=binding.getPreferredColorFormat();
        const layer=binding.createProjectionLayer({colorFormat:format,scaleFactor:scale});
        const pipeline=await device.createRenderPipelineAsync({
            layout:'auto', vertex:{module:shader,entryPoint:'vertex'},
            fragment:{module:shader,entryPoint:'fragment',targets:[{format,blend:{
                color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},
                alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}
            }}]}, primitive:{topology:'triangle-strip'}
        });
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
        const coefficients=buffer(src.sh.byteLength,GPUBufferUsage.STORAGE,src.sh);
        const indices=buffer(src.n*4,GPUBufferUsage.STORAGE);
        const views=[0,1].map(()=>{
            const uniform=buffer(160,GPUBufferUsage.UNIFORM);
            const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),
                entries:[uniform,splats,coefficients,indices].map((buffer,binding)=>({binding,resource:{buffer}}))});
            return {uniform,bind};
        });
        const packed=new Float32Array(40), mode=new Uint32Array(packed.buffer,36*4);
        session.updateRenderState({layers:[layer]});
        return {
            label:'Immersive WebGPU',
            destroy:()=>device.destroy(),
            draw(eyes,center) {
                sortVisible(eyes,center,false);
                if(drawCount) device.queue.writeBuffer(indices,0,sortData.ids,0,drawCount);
                const encoder=device.createCommandEncoder();
                const images=eyes.map(eye=>binding.getViewSubImage(layer,eye.xrView));
                const left=images[0].viewport;
                for(const [i,eye] of eyes.entries()) {
                    const image=images[i], viewport=image.viewport;
                    packed.set(eye.xrView.projectionMatrix,0);
                    packed.set(eye.pos,16);packed.set(eye.right,20);
                    packed.set(eye.down,24);packed.set(eye.f,28);
                    packed[32]=left.width/(2*eyes[0].tan[0]);
                    packed[33]=left.height/(2*eyes[0].tan[1]);
                    mode.set([src.width*src.height,src.degree,Number($('mip').checked),
                        Number($('sh').checked)|Number($('quant').checked)*2|Number($('color').value==='1')*4]);
                    device.queue.writeBuffer(views[i].uniform,0,packed);
                    const descriptor=image.getViewDescriptor();
                    const pass=encoder.beginRenderPass({colorAttachments:[{
                        view:image.colorTexture.createView(descriptor),
                        loadOp:i>0&&images[0].colorTexture===image.colorTexture&&
                            images[0].getViewDescriptor().baseArrayLayer===descriptor.baseArrayLayer?'load':'clear',
                        storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}
                    }]});
                    pass.setViewport(viewport.x,viewport.y,viewport.width,viewport.height,0,1);
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0,views[i].bind);
                    pass.draw(4,drawCount);
                    pass.end();
                }
                device.queue.submit([encoder.finish()]);
            }
        };
    } catch(error) {
        device.destroy();
        throw error;
    }
}
