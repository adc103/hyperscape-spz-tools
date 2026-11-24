const splatVertex = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
layout(location=0) in uint index;
uniform sampler2D points, scales, rotations, dc;
uniform sampler2DArray sh;
uniform vec3 eye;
uniform mat3 camera;
uniform vec2 tangent, shift, focal;
uniform float nearPlane, farPlane;
uniform int degree;
uniform bool mip, shFoveated, quant, linearColor;
uniform vec2 fadeRange;
uniform float count, lodMultiplier, lodFade;
uniform vec2 lodDistances, lodFractions, peripheralMip, peripheralCenter;
uniform vec3 detailEye;
out vec2 uv;
flat out vec4 rgba;
flat out float centerLength;

vec3 rotate(vec4 q, vec3 p) { return p+2.0*cross(q.xyz,cross(q.xyz,p)+q.w*p); }
vec2 halves(vec2 p) { return unpackHalf2x16(packHalf2x16(p)); }
vec3 halves3(vec3 p) { return vec3(halves(p.xy),halves(vec2(p.z,0)).x); }
void reject() { gl_Position=vec4(2,2,2,1); uv=vec2(0); rgba=vec4(0); centerLength=0.0; }
void main() {
    ivec2 ij=ivec2(int(index&1023u), int(index>>10u));
    vec4 samplePoint=texelFetch(points,ij,0);
    vec3 dir=samplePoint.xyz-eye;
    vec3 center=camera*dir;
    if(center.z<=0.0) { reject(); return; }
    vec4 q=texelFetch(rotations,ij,0);
    vec3 p=rotate(vec4(-q.xyz,q.w),dir);
    vec3 s=texelFetch(scales,ij,0).xyz;
    vec2 ndc=vec2(center.x,-center.y)/center.z/tangent+shift;
    float factor=1.0;
    if(peripheralMip.x>0.0 && peripheralMip.y>0.0)
        factor+=smoothstep(peripheralMip.x*(1.0-peripheralMip.y*.01),peripheralMip.x,length(ndc-peripheralCenter)*.5);
    vec3 f=sqrt(s*s+vec3(mip ? .1*dot(p,p)*factor*factor/abs(focal.x*focal.y) : 0.0));
    vec3 whitened=p/f;
    float c=length(whitened);
    if(c<=0.00001) { reject(); return; }
    float opacity=samplePoint.w;
    if(mip) opacity*=length(p*s.yzx*s.zxy)/(f.x*f.y*f.z*c);
    opacity=halves(vec2(opacity,0)).x;
    if(opacity<.0625) { reject(); return; }
    vec3 normal=whitened/c;
    float signZ=normal.z>0.0 ? 1.0 : -1.0;
    vec3 v=normal+vec3(0,0,signZ);
    vec3 u=camera*rotate(q,f*(2.0*v*v.x/dot(v,v)-vec3(1,0,0))*signZ);
    vec3 w=camera*rotate(q,f*(2.0*v*v.y/dot(v,v)-vec3(0,1,0)));
    float a=dot(u,u), b=dot(u,w), d=dot(w,w);
    float angle=(abs(a-d)+abs(b)>1e-16) ? .5*atan(2.0*b,a-d) : 0.0;
    float ca=cos(angle), sa=sin(angle);
    vec3 qa=halves3(u*ca+w*sa), qb=halves3(-u*sa+w*ca);
    center=halves3(center);
    c=halves(vec2(min(c,65504.0),0)).x;
    float k=9.0-9.0/(255.0*opacity);
    if(k<=0.0 || c*c<=k) { reject(); return; }
    float extent=sqrt(k*c*c/(c*c-k));
    if(opacity<.20) opacity*=1.0-clamp((center.z-fadeRange.x)/(fadeRange.y-fadeRange.x),0.0,1.0);
    if(lodFade>0.0) {
        float fadeDistance=length(samplePoint.xyz-detailEye);
        float amount=clamp((fadeDistance-lodDistances.x)/(lodDistances.y-lodDistances.x),0.0,1.0);
        float fraction=mix(lodFractions.x,lodFractions.y,amount)*lodMultiplier;
        opacity*=clamp((fraction-float(index)/count)/lodFade,0.0,1.0);
    }
    if(opacity<.0625) { reject(); return; }

    vec3 n=normalize(dir);
    float x=n.x, y=n.y, z=n.z;
    float xx=x*x, yy=y*y, zz=z*z;
    float coeff[15]=float[15](
        -.4886025119*y,.4886025119*z,-.4886025119*x,
        1.0925484306*x*y,-1.0925484306*y*z,.3153915653*(2.0*zz-xx-yy),
        -1.0925484306*x*z,.5462742153*(xx-yy),
        -.5900435899*y*(3.0*xx-yy),2.8906114426*x*y*z,
        -.4570457995*y*(4.0*zz-xx-yy),.3731763326*z*(2.0*zz-3.0*xx-3.0*yy),
        -.4570457995*x*(4.0*zz-xx-yy),1.4453057213*z*(xx-yy),
        -.5900435899*x*(xx-3.0*yy));
    float detail=shFoveated ? float(degree)*(1.0-smoothstep(.5,1.0,length(center.xy/center.z))) : float(degree);
    vec3 col=texelFetch(dc,ij,0).xyz*.2820948064+.5;
    for(int i=0;i<15;++i) {
        float band=float(i<3 ? 0 : i<8 ? 1 : 2);
        float weight=clamp(detail-band,0.0,1.0);
        if(weight<=0.0) break;
        vec3 shRGB=texelFetch(sh,ivec3(ij,i),0).xyz;
        if(quant) shRGB=(clamp(floor(128.0*shRGB+128.5),0.0,255.0)-128.0)/128.0;
        col+=shRGB*(coeff[i]*weight);
    }
    col=max(col,vec3(0));
    if(linearColor) col=pow(col,vec3(2.2));
    rgba=vec4(halves3(col),opacity);
    centerLength=c;
    uv=extent*vec2((gl_VertexID&1)==0 ? -1.0 : 1.0,(gl_VertexID&2)==0 ? -1.0 : 1.0);
    vec3 pos=center+qa*uv.x+qb*uv.y;
    float clipZ=(farPlane+nearPlane)/(farPlane-nearPlane)*pos.z-2.0*farPlane*nearPlane/(farPlane-nearPlane);
    gl_Position=vec4(pos.x/tangent.x+shift.x*pos.z,-pos.y/tangent.y+shift.y*pos.z,clipZ,pos.z);
}`;

const splatFragment = `#version 300 es
precision highp float;
in vec2 uv;
flat in vec4 rgba;
flat in float centerLength;
out vec4 result;
void main() {
    float radial=dot(uv,uv), c2=centerLength*centerLength;
    float d=radial/(1.0+radial/c2);
    float alpha=rgba.a*(1.0-d/9.0);
    if(alpha<1.0/255.0) discard;
    result=vec4(rgba.rgb*alpha,alpha);
}`;

const screenVertex = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
    uv=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
    gl_Position=vec4(uv*2.0-1.0,0,1);
}`;

const screenFragment = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 result;
uniform sampler2D sharp, soft;
uniform bool compositeColor, foveated;
uniform int reprojection;
uniform bool alphaEnabled, unpremultiply;
uniform vec4 alphaCurve;
uniform float alphaCutoff;
uniform vec3 eye, prevEye;
uniform mat3 camera, prevCamera;
uniform vec2 tangent, shift, prevTangent, prevShift;
uniform float clipDepth;
uniform vec4 teleportMarker;
uniform vec2 peripheralCenter;
vec2 previousUV() {
    vec2 p=(uv*2.0-1.0-shift)*tangent;
    vec3 world=eye+transpose(camera)*vec3(p.x,-p.y,1.0)*clipDepth;
    vec3 old=prevCamera*(world-prevEye);
    if(old.z<=0.0) return uv;
    vec2 sampleUV=(vec2(old.x,-old.y)/old.z/prevTangent+prevShift)*.5+.5;
    return any(lessThan(sampleUV,vec2(0))) || any(greaterThan(sampleUV,vec2(1))) ? uv : sampleUV;
}
void main() {
    vec2 oldUV=reprojection==0 ? uv : previousUV();
    vec4 full=texture(sharp,reprojection==2 ? oldUV : uv);
    if(foveated) {
        vec4 low=texture(soft,reprojection==1 ? oldUV : uv);
        vec2 radial=(uv*2.0-1.0-peripheralCenter)*tangent;
        full=mix(full,low,smoothstep(.45,.85,length(radial)));
    }
    if(alphaEnabled && full.a>0.0) {
        vec3 straight=full.rgb/full.a;
        float a=pow(full.a,alphaCurve.x);
        if(a>alphaCurve.y) a=clamp(alphaCurve.z*a-alphaCurve.w,0.0,1.0);
        full=vec4(straight*a,a);
    }
    if(full.a<alphaCutoff) full=vec4(0);
    vec3 rgb=compositeColor ? pow(max(full.rgb,vec3(0)),vec3(2.2)) : full.rgb;
    if(unpremultiply && full.a>0.0) rgb/=full.a;
    if(teleportMarker.w>0.0) {
        vec2 p=(uv*2.0-1.0-shift)*tangent;
        vec3 ray=transpose(camera)*vec3(p.x,-p.y,1.0);
        if(ray.z<-.001) {
            float depth=(teleportMarker.z-eye.z)/ray.z;
            float radius=length(eye.xy+depth*ray.xy-teleportMarker.xy);
            if(depth>0.0 && radius>.16 && radius<.23)
                rgb=mix(rgb,vec3(.92,.81,.44),.95);
        }
    }
    result=vec4(rgb,1);
}`;
