'use strict';

importScripts('navigation.js');

let points, ids, scratch, keys;
const bins=new Uint32Array(256);
const float=new Float32Array(1);
const bits=new Uint32Array(float.buffer);

function frustum(eye) {
    const {pos,right,down,f,tan,shift,near,far}=eye;
    return (x,y,z)=>{
        x-=pos[0]; y-=pos[1]; z-=pos[2];
        const depth=x*f[0]+y*f[1]+z*f[2];
        if(depth<near*.65||depth>far) return false;
        const u=(x*right[0]+y*right[1]+z*right[2])/tan[0]+shift[0]*depth;
        const v=-(x*down[0]+y*down[1]+z*down[2])/tan[1]+shift[1]*depth;
        // Keep splats just outside the frustum while a newer result is in flight.
        const margin=depth*1.4+.15;
        return Math.abs(u)<=margin&&Math.abs(v)<=margin;
    };
}

function sort({eyes,center,detail,lod,quality,narrow,front,cap},output) {
    const first=eyes[0], second=eyes[1]??first;
    const left=frustum(first), right=second===first?left:frustum(second);
    const [ex,ey,ez]=first.pos,[sx,sy,sz]=second.pos,[mx,my,mz]=center;
    const count=points.length/4;
    let seen=0;
    for(let i=0;i<count&&seen<cap;i++) {
        const j=i*4;
        if(points[j+3]<.0625) continue;
        const x=points[j],y=points[j+1],z=points[j+2];
        const ax=x-ex,ay=y-ey,az=z-ez;
        const nearDistance=ax*ax+ay*ay+az*az;
        if(detail) {
            const dx=x-mx,dy=y-my,dz=z-mz;
            const distance=Math.sqrt(dx*dx+dy*dy+dz*dz);
            const t=Math.max(0,Math.min(1,(distance-lod.start)/(lod.end-lod.start)));
            if(i>count*quality*(lod.near+(lod.far-lod.near)*t)) continue;
        }
        if(!left(x,y,z)&&(second===first||!right(x,y,z))) continue;
        const bx=x-sx,by=y-sy,bz=z-sz;
        const distance=second===first?Math.sqrt(nearDistance):
            .5*(Math.sqrt(nearDistance)+Math.sqrt(bx*bx+by*by+bz*bz));
        if(narrow) {
            const t=Math.max(0,Math.min(1,(distance-.1)/1499.9));
            const key=Math.floor((1-t**.4)*65534+.5);
            keys[i]=front?65535-key:key;
        } else {
            float[0]=1/(distance+1e-7);
            keys[i]=front?~bits[0]:bits[0];
        }
        ids[seen++]=i;
    }
    let source=ids, dest=scratch;
    for(let shift=0;shift<(narrow?16:32);shift+=8) {
        bins.fill(0);
        for(let i=0;i<seen;i++) bins[(keys[source[i]]>>>shift)&255]++;
        let prefix=0;
        for(let bin=0;bin<256;bin++) {
            const size=bins[bin];
            bins[bin]=prefix;
            prefix+=size;
        }
        for(let i=0;i<seen;i++) {
            const id=source[i];
            dest[bins[(keys[id]>>>shift)&255]++]=id;
        }
        [source,dest]=[dest,source];
    }
    output.set(source.subarray(0,seen));
    return seen;
}

self.onmessage=({data})=>{
    if(data.points) {
        points=data.points;
        const size=points.length/4;
        ids=new Uint32Array(size);
        scratch=new Uint32Array(size);
        keys=new Uint32Array(size);
        if(data.origin) {
            const nav=buildNavigation(points,data.origin);
            self.postMessage({nav},[nav.walkable.buffer,nav.blocked.buffer]);
        }
        return;
    }
    const output=new Uint32Array(data.buffer);
    const count=sort(data,output);
    self.postMessage({count,buffer:output.buffer},[output.buffer]);
};
