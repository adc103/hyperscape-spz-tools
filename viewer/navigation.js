'use strict';

const navCellSize=.20;
const navMaxRadius=80;
const navStride=1024;
const navOffset=navStride/2;

function navigationKey(x,y) {
    const col=Math.floor(x/navCellSize)+navOffset;
    const row=Math.floor(y/navCellSize)+navOffset;
    if(col<0||col>=navStride||row<0||row>=navStride) return -1;
    return row*navStride+col;
}

function buildNavigation(points,start) {
    const [ox,oy,eyeHeight]=start;
    const guess=eyeHeight-1.6, binWidth=.05, window=.65;
    const bins=Array.from({length:27},()=>new Set());
    for(let i=0;i<points.length;i+=4) {
        if(points[i+3]<.22) continue;
        const x=points[i]-ox,y=points[i+1]-oy;
        if(x*x+y*y>2.5**2) continue;
        const h=points[i+2]-guess;
        const bin=Math.round((h+window)/binWidth);
        if(bins[bin]) bins[bin].add(navigationKey(x,y));
    }
    let best=0,size=0;
    for(let i=0;i<bins.length;i++) {
        const score=bins[i].size*(1-.4*Math.abs(i*binWidth-window)/window);
        if(score>size) {best=i;size=score;}
    }
    if(size<9) return {floor:guess,walkable:new Int32Array(),blocked:new Int32Array()};
    const floor=guess-window+best*binWidth;
    const cells=new Map();
    for(let i=0;i<points.length;i+=4) {
        if(points[i+3]<.18) continue;
        const x=points[i]-ox,y=points[i+1]-oy,z=points[i+2]-floor;
        if(Math.abs(x)>navMaxRadius||Math.abs(y)>navMaxRadius||z<-.12||z>1.72) continue;
        const key=navigationKey(x,y);
        const cell=cells.get(key)??[0,0,0,0,0,0];
        if(!cells.has(key)) cells.set(key,cell);
        if(z<=.105) cell[0]++;
        else if(z>.18) cell[1+Math.min(4,Math.floor((z-.18)/.31))]++;
    }
    const walkable=[],blocked=[];
    for(const [key,[ground,...body]] of cells) {
        const occupied=body.filter(n=>n>=5).length;
        // Upright surfaces span several bands. Dense low obstacles also block landing.
        if(occupied>=3||(body[0]>=16&&body[1]>=8)||body[0]>=40) blocked.push(key);
        if(ground>=4) walkable.push(key);
    }
    return {floor,walkable:Int32Array.from(walkable),blocked:Int32Array.from(blocked)};
}

function readNavigation(data,start) {
    return {floor:data.floor,walkable:new Set(data.walkable),blocked:new Set(data.blocked),origin:start};
}

function validTeleport(nav,from,to) {
    const [ox,oy]=nav.origin;
    const dx=to[0]-from[0],dy=to[1]-from[1];
    const distance=Math.hypot(dx,dy);
    if(distance<.25||distance>5) return false;
    const steps=Math.ceil(distance/(navCellSize*.3));
    function supported(x,y) {
        const key=navigationKey(x-ox,y-oy);
        return key!==-1&&nav.walkable.has(key)&&!nav.blocked.has(key);
    }
    // Probe a corridor along the ray. Endpoints must have floor support across the footprint.
    const sideX=-dy/distance,sideY=dx/distance;
    for(let i=1;i<=steps;i++) {
        const x=from[0]+dx*i/steps,y=from[1]+dy*i/steps;
        const key=navigationKey(x-ox,y-oy);
        if(key===-1||nav.blocked.has(key)) return false;
        if(i/steps*distance<.22) continue;
        if(!supported(x,y)||!supported(x+sideX*.12,y+sideY*.12)||!supported(x-sideX*.12,y-sideY*.12))
            return false;
    }
    const [x,y]=to;
    return [[.16,0],[-.16,0],[0,.16],[0,-.16]].every(([a,b])=>supported(x+a,y+b));
}

function limitTeleport(nav,from,candidate) {
    const dx=candidate[0]-from[0],dy=candidate[1]-from[1];
    const distance=Math.hypot(dx,dy);
    // If the aim ray reaches past a boundary, offer the nearest supported stop along it.
    for(let length=Math.min(5,distance);length>=.25;length-=navCellSize*.75) {
        const scale=length/distance;
        const target=[from[0]+dx*scale,from[1]+dy*scale,nav.floor];
        if(validTeleport(nav,from,target)) return target;
    }
    return null;
}
